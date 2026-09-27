(function(){
'use strict';

const PAGINA_ACCESO = '../auth/auth.html';
const TIPOS = Acu.TIPOS;
const PISTA_BASE = 'Elige qué quieres dibujar, o usa las herramientas del mapa y asigna la función después.';
const PISTAS = {
  casa:'Toca el mapa en cada esquina de la casa. Toca el primer punto para cerrarla.',
  tuberia:'Traza la tubería en el sentido en que corre el agua: empieza donde entra. Toca el último punto otra vez para terminar.',
  llave:'Toca el mapa donde está la llave.',
  sector:'Toca el mapa alrededor de la zona. Toca el primer punto para cerrar el sector.',
  acometida:'Empieza tocando sobre la tubería y termina tocando dentro de la casa. Toca el último punto otra vez para terminar.',
  conectorT:'Toca sobre la tubería donde va la unión en T: se corta sola. Después eliges en el panel por cuál brazo entra el agua.',
  conectorY:'Toca sobre la tubería donde va la unión en Y: se corta sola. Después eliges en el panel por cuál brazo entra el agua.'
};
const ROJO = Acu.ROJO;
const PALETA = ['#1E88E5','#3B6EA8','#1596C4','#2F8F5B','#C8901A','#C0392B','#8A4FBF','#E0679A','#6F7F85','#15323B'];
const ESTADO_COLOR = {ok:'#2F8F5B', warn:'#E0A526', bad:'#C0392B'};
const VISTA_KEY = 'acueducto-vista';
const LOCAL_V1 = 'acueducto-v1';
const LOCAL_V1_SUBIDO = 'acueducto-v1-subido';

const state = { settings:{nombre:'Mi acueducto', cuota:5, moneda:'B/.', colorPorPago:true, whatsapp:'', whatsappMensaje:'', whatsappActivo:false, correoContacto:''} };
const capas = new Map();
let selected = null;
let pendingTipo = null;
let sb = null;
const incidencias = new Map();   // id -> fila de la tabla incidencias
let tiposInc = [];               // [{id, nombre, orden}]
let afectados = new Map();       // id de forma -> incidencias abiertas que la afectan
let versionGeo = 0, grafoCache = null;
let formIncAbierto = false;

/* ================= Utilidades ================= */
const $ = s => document.querySelector(s);
const esc = Acu.esc, num = Acu.num;
const uid = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const CLIENTE_ID = uid();
const dinero = n => `${state.settings.moneda || ''} ${num(n).toFixed(2)}`.trim();
const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function aviso(txt, ms){ const a = $('#aviso'); a.textContent = txt; a.classList.add('ver'); clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('ver'), ms || 3500); }

/* Traduce los errores de Supabase a una explicación útil */
const MSG_BD_VIEJA = 'La base de datos no está actualizada: ejecuta el archivo supabase.sql en el SQL Editor de Supabase y recarga esta página.';
function explicarError(e){
  const code = e && e.code;
  const m = String((e && (e.message || e.details || e.hint)) || e || '');
  if (code === 'PGRST204' || code === 'PGRST205' || code === '42703' || code === '42P01' ||
      /could not find the .* (column|table)|column .* does not exist|relation .* does not exist|schema cache/i.test(m)) return MSG_BD_VIEJA;
  if (code === '42501' || /row-level security|permission denied/i.test(m)) return 'Tu usuario no tiene permiso para guardar esto. Cierra sesión y vuelve a entrar.';
  if (code === 'PGRST301' || code === 'PGRST303' || /jwt|token.*expired|invalid claim/i.test(m)) return 'Tu sesión expiró. Cierra sesión y vuelve a entrar.';
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(m) || !navigator.onLine) return 'No hay conexión a internet. Revisa tu conexión e inténtalo de nuevo.';
  if (code === '23503') return 'El elemento ya no existe en la base de datos. Recarga la página.';
  if (code === '23505') return 'Ya existe un registro igual.';
  if (code === '23514' && /formas_tipo_check/.test(m)) return MSG_BD_VIEJA;
  if (code === '23514') return 'Algún dato no es válido (' + m + ').';
  return 'Detalle del error: ' + m;
}
const esPunto = l => l instanceof L.CircleMarker;
const esPoligono = l => l instanceof L.Polygon;
const esLinea = l => l instanceof L.Polyline && !(l instanceof L.Polygon);

function datosBase(tipo){
  if (tipo === 'casa') return {numero:'', responsable:'', telefono:'', nucleos:1, personas:'', inicioCobro:'', cuotaEspecial:'', deudaAnterior:'', pagos:[], notas:''};
  if (tipo === 'tuberia') return {nombre:'', clase:'principal', flujo:'', sectores:[], diametro:'', material:'PVC', notas:''};
  if (tipo === 'llave') return {nombre:'', estado:'abierta', notas:''};
  if (tipo === 'sector') return {nombre:'', opacidad:0.35, activo:false, activoDesde:'', notas:''};
  if (tipo === 'conector') return {nombre:'', forma:'T', rotacion:0, espejo:false, tamano:TAMANO_UNION, entrada:null, notas:''};
  return {notas:''};
}

/* ================= Guardado en Supabase ================= */
let canal = null, appIniciada = false;
const pendientes = new Set();
let enVuelo = 0, errorSync = null, flushTimer = null, flushEnCurso = null, enVivo = false;

function pintarSync(){
  const el = $('#sync');
  let cls = 'ok', txt = enVivo ? 'Guardado y en vivo' : 'Guardado';
  if (enVuelo || pendientes.size){ cls = 'trabajando'; txt = 'Guardando…'; }
  if (errorSync){ cls = 'error'; txt = 'Sin guardar, reintentando'; }
  if (!navigator.onLine){ cls = 'error'; txt = 'Sin internet'; }
  el.className = 'sync ' + cls; el.textContent = txt; el.title = errorSync || '';
}
$('#sync').addEventListener('click', () => { if (errorSync || pendientes.size) flush(); });
window.addEventListener('online', () => { pintarSync(); flush(); });
window.addEventListener('offline', pintarSync);
window.addEventListener('beforeunload', e => { if (pendientes.size || enVuelo){ e.preventDefault(); e.returnValue = ''; } });

async function tarea(consulta, msgError){
  enVuelo++; pintarSync();
  try {
    const {error} = await consulta;
    if (error) throw error;
    errorSync = null;
    return true;
  } catch (e){
    console.error(e);
    errorSync = e.message || String(e);
    aviso((msgError || 'No se pudo guardar') + '. ' + explicarError(e), 9000);
    if (explicarError(e) === MSG_BD_VIEJA) mostrarAlertaBD();
    return false;
  } finally { enVuelo--; pintarSync(); }
}

function fila(layer){
  const aq = layer.aq;
  const {pagos, ...datos} = aq.datos;
  return {id:aq.id, tipo:aq.tipo, color:aq.color, color_manual:!!aq.colorManual,
    geometria:layer.toGeoJSON().geometry, datos, editado_por:CLIENTE_ID};
}
function guardarForma(id, rapido){
  pendientes.add(id); pintarSync();
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, rapido ? 50 : 700);
}
async function flush(){
  clearTimeout(flushTimer);
  if (flushEnCurso) await flushEnCurso;
  if (!pendientes.size || !sb){ pintarSync(); return; }
  const ids = [...pendientes]; pendientes.clear();
  const filas = ids.map(id => capas.get(id)).filter(Boolean).map(fila);
  if (!filas.length){ pintarSync(); return; }
  flushEnCurso = (async () => {
    enVuelo++; pintarSync();
    const {error} = await sb.from('formas').upsert(filas);
    enVuelo--;
    if (error){
      console.error(error);
      ids.forEach(id => { if (capas.has(id)) pendientes.add(id); });
      if (errorSync !== error.message) aviso('No se pudieron guardar los cambios del mapa. ' + explicarError(error), 9000);
      if (explicarError(error) === MSG_BD_VIEJA) mostrarAlertaBD();
      errorSync = error.message;
      flushTimer = setTimeout(flush, 10000);
    } else errorSync = null;
    pintarSync();
  })();
  await flushEnCurso; flushEnCurso = null;
}

const guardarConfig = debounce(() => {
  const s = state.settings;
  tarea(sb.from('configuracion').upsert({id:1, nombre:s.nombre, cuota:num(s.cuota), moneda:s.moneda,
    color_por_pago:!!s.colorPorPago, whatsapp:s.whatsapp || null, whatsapp_mensaje:s.whatsappMensaje || null,
    whatsapp_activo:!!s.whatsappActivo, correo_contacto:s.correoContacto || null, editado_por:CLIENTE_ID}), 'No se pudo guardar la configuración');
}, 600);

const pagoDesdeFila = p => ({id:p.id, fecha:p.fecha, monto:num(p.monto), nota:p.nota || ''});
function aqDesdeFila(r, pagos){
  const tipo = TIPOS[r.tipo] ? r.tipo : 'sin';
  const datos = Object.assign(datosBase(tipo), r.datos || {});
  datos.pagos = pagos || [];
  return {id:r.id, tipo, color:r.color || TIPOS[tipo].color, colorManual:!!r.color_manual, datos};
}
function aplicarFilaConfig(r){
  state.settings = {nombre:r.nombre || 'Mi acueducto', cuota:num(r.cuota), moneda:r.moneda ?? 'B/.', colorPorPago:!!r.color_por_pago,
    whatsapp:r.whatsapp || '', whatsappMensaje:r.whatsapp_mensaje || '', whatsappActivo:!!r.whatsapp_activo, correoContacto:r.correo_contacto || ''};
}

async function cargarTodo(){
  const [cfg, formas, pagos, incs, tipos] = await Promise.all([
    sb.from('configuracion').select('*').eq('id', 1).maybeSingle(),
    Acu.traerTodo(sb, 'formas'),
    Acu.traerTodo(sb, 'pagos'),
    Acu.traerTodo(sb, 'incidencias'),
    sb.from('tipos_incidencia').select('*').order('orden').order('nombre')
  ]);
  if (cfg.error) throw cfg.error;
  if (tipos.error) throw tipos.error;
  if (cfg.data) aplicarFilaConfig(cfg.data);
  tiposInc = tipos.data || [];
  incidencias.clear();
  incs.forEach(r => incidencias.set(r.id, r));
  const porForma = {};
  pagos.forEach(p => (porForma[p.forma_id] = porForma[p.forma_id] || []).push(pagoDesdeFila(p)));
  cerrarPanel();
  capa.clearLayers(); capas.clear(); versionGeo++;
  formas.forEach(r => {
    const layer = Acu.capaDesdeGeom(r.geometria);
    if (layer) agregarCapa(layer, aqDesdeFila(r, porForma[r.id]));
  });
  ordenarSectores();
  cargarConfigEnFormulario();
  renderTiposInc();
  recalcularIncidencias();
  renderResumen();
}

/* --- Cambios en vivo desde otros administradores --- */
function suscribir(){
  if (canal) sb.removeChannel(canal);
  canal = sb.channel('acueducto-adm')
    .on('postgres_changes', {event:'*', schema:'public', table:'formas'}, p => {
      if (p.eventType === 'DELETE'){
        const l = capas.get(p.old.id);
        if (l){ quitarCapaLocal(l); quitarIncidenciasDe(p.old.id); renderResumenPronto(); }
        return;
      }
      const r = p.new;
      if (r.editado_por === CLIENTE_ID || pendientes.has(r.id)) return;
      aplicarFilaForma(r);
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'pagos'}, p => {
      const r = p.eventType === 'DELETE' ? p.old : p.new;
      const l = capas.get(r.forma_id); if (!l) return;
      const lista = l.aq.datos.pagos = l.aq.datos.pagos || [];
      const i = lista.findIndex(x => x.id === r.id);
      if (p.eventType === 'DELETE'){ if (i >= 0) lista.splice(i, 1); else return; }
      else if (i >= 0) lista[i] = pagoDesdeFila(r);
      else lista.push(pagoDesdeFila(r));
      refrescarForma(l);
      if (selected === l) renderPagos();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'configuracion'}, p => {
      if (!p.new || p.new.editado_por === CLIENTE_ID) return;
      aplicarFilaConfig(p.new);
      if (!document.activeElement || !document.activeElement.id.startsWith('cfg')) cargarConfigEnFormulario();
      capa.eachLayer(l => { if (l.aq){ aplicarEstilo(l); actualizarTooltip(l); } });
      if (selected){ actualizarTituloPanel(); refrescarCuenta(); }
      renderResumen();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'incidencias'}, p => {
      if (p.eventType === 'DELETE') incidencias.delete(p.old.id);
      else incidencias.set(p.new.id, p.new);
      recalcularPronto();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'tipos_incidencia'}, async () => {
      const {data} = await sb.from('tipos_incidencia').select('*').order('orden').order('nombre');
      if (data){ tiposInc = data; renderTiposInc(); }
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'solicitudes_registro'}, p => {
      if (p.eventType === 'INSERT') aviso('Nueva solicitud de registro: ' + (p.new.nombre || ''), 6000);
      cargarUsuariosPronto();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'reportes'}, p => {
      if (p.eventType === 'INSERT') aviso('Nuevo reporte de un vecino: ' + (p.new.tipo || ''), 6000);
      cargarUsuariosPronto();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'perfiles'}, cargarUsuariosPronto)
    .on('postgres_changes', {event:'*', schema:'public', table:'cargos'}, cargarUsuariosPronto)
    .subscribe(status => { enVivo = status === 'SUBSCRIBED'; pintarSync(); });
}
function aplicarFilaForma(r){
  const prev = capas.get(r.id);
  const nueva = Acu.capaDesdeGeom(r.geometria); if (!nueva) return;
  const pagos = prev ? prev.aq.datos.pagos : [];
  const eraSel = prev && selected === prev;
  if (prev){
    if (eraSel) selected = null;
    capa.removeLayer(prev); map.removeLayer(prev); capas.delete(r.id);
  }
  agregarCapa(nueva, aqDesdeFila(r, pagos));
  if (eraSel) seleccionar(nueva);
  renderResumenPronto();
}

/* ================= Cuotas ================= */
function cuenta(aq){
  const d = aq.datos || {};
  const nuc = Math.max(0, num(d.nucleos));
  const especial = d.cuotaEspecial !== '' && d.cuotaEspecial != null && isFinite(Number(d.cuotaEspecial));
  const cuotaMes = especial ? num(d.cuotaEspecial) : nuc * num(state.settings.cuota);
  let meses = 0;
  if (d.inicioCobro && /^\d{4}-\d{2}$/.test(d.inicioCobro)){
    const [y, m] = d.inicioCobro.split('-').map(Number);
    const h = new Date();
    meses = Math.max(0, (h.getFullYear()*12 + h.getMonth() + 1) - (y*12 + m) + 1);
  }
  const pagado = (d.pagos || []).reduce((s, p) => s + num(p.monto), 0);
  const esperado = meses * cuotaMes + num(d.deudaAnterior);
  const saldo = Math.round((esperado - pagado) * 100) / 100;
  const atraso = saldo > 0 ? (cuotaMes > 0 ? Math.ceil(saldo / cuotaMes - 1e-9) : 1) : 0;
  const aplica = !!d.inicioCobro || num(d.deudaAnterior) > 0 || (d.pagos || []).length > 0;
  const nivel = saldo <= 0 ? 'ok' : (atraso <= 1 ? 'warn' : 'bad');
  return {cuotaMes, meses, pagado, esperado, saldo, atraso, aplica, nivel, especial};
}
function textoEstado(c){
  if (!c.aplica) return {cls:'nada', txt:'Sin cobro'};
  if (c.saldo < 0) return {cls:'ok', txt:'Adelantado ' + dinero(-c.saldo)};
  if (c.saldo === 0) return {cls:'ok', txt:'Al día'};
  return {cls:c.nivel, txt:`Debe ${dinero(c.saldo)}`};
}
function longitud(layer){
  if (!esLinea(layer)) return 0;
  const pts = layer.getLatLngs().flat(Infinity);
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += map.distance(pts[i-1], pts[i]);
  return m;
}

/* ================= Mapa ================= */
const map = Acu.crearMapa('map', {aviso});
try {
  const v = JSON.parse(localStorage.getItem(VISTA_KEY) || 'null');
  if (v) map.setView([v.lat, v.lng], v.zoom);
} catch (e){}
map.on('moveend', debounce(() => {
  const c = map.getCenter();
  try { localStorage.setItem(VISTA_KEY, JSON.stringify({lat:c.lat, lng:c.lng, zoom:map.getZoom()})); } catch (e){}
}, 500));

const capa = L.featureGroup().addTo(map);
map.pm.setLang('es');
map.pm.addControls({
  position:'topleft',
  drawMarker:false, drawCircle:false, drawText:false, drawCircleMarker:true,
  drawPolyline:true, drawRectangle:true, drawPolygon:true,
  cutPolygon:false, rotateMode:false
});
map.pm.setGlobalOptions({layerGroup:capa, snappable:true, snapDistance:18});

/* ================= Estilo y etiquetas ================= */
function colorDe(aq){
  if (aq.tipo === 'tuberia') return Acu.COLOR_TUBERIA;
  if (aq.tipo === 'casa' && state.settings.colorPorPago){
    const c = cuenta(aq);
    if (c.aplica) return ESTADO_COLOR[c.nivel];
  }
  return aq.color || TIPOS[aq.tipo].color;
}
function marcarClase(layer, cls, si){
  const el = layer.getElement && layer.getElement();
  if (el) el.classList.toggle(cls, !!si);
}
function aplicarEstilo(layer){
  const aq = layer.aq; if (!aq) return;
  const sel = layer === selected;
  if (layer._decor){ capaConectores.removeLayer(layer._decor); layer._decor = null; }
  if (aq.tipo === 'conector' && esPunto(layer)){
    const inc = afectados.get(aq.id), col = inc && inc.length ? (inc[0].color || ROJO) : COLOR_CONECTOR;
    layer.setStyle({radius:7, color:sel ? '#FFD23F' : '#fff', weight:sel ? 4 : 2, fillColor:col, fillOpacity:1, opacity:1, dashArray:null});
    marcarClase(layer, 'con-incidencia', !!(inc && inc.length));
    if (layer._map){
      layer._decor = Acu.formaConector(layer.getLatLng(), aq.datos, {color:col, puertos:true, etiquetas:sel || map.getZoom() >= 20});
      capaConectores.addLayer(layer._decor);
      layer.bringToFront();
    }
    return;
  }
  const incs = afectados.get(aq.id);
  if (incs && incs.length){
    const inc = incs[0];
    const col = inc.color || ROJO;
    const op = Math.min(1, Math.max(0.05, num(inc.opacidad) || 0.75));
    Acu.quitarClasesSector(layer);
    if (esPunto(layer)){
      layer.setStyle({radius: aq.tipo === 'llave' ? 9 : 7, color: sel ? '#FFD23F' : '#fff', weight: sel ? 4 : 2,
        fillColor: col, fillOpacity: op, opacity:1, dashArray:null});
    } else if (esPoligono(layer)){
      layer.setStyle({color: sel ? '#FFD23F' : col, weight: sel ? 4 : 2.5, opacity:1, fillColor: col, fillOpacity: op, dashArray:null});
    } else {
      const base = aq.tipo === 'tuberia' && aq.datos.clase === 'acometida' ? 3.5 : 5.5;
      layer.setStyle({color: col, weight: base + (sel ? 3 : 0), opacity: op, lineCap:'round', dashArray:null});
    }
    marcarClase(layer, 'con-incidencia', true);
    if (aq.tipo === 'sector' && layer._map) layer.bringToBack();
    return;
  }
  marcarClase(layer, 'con-incidencia', false);
  if (aq.tipo === 'sector' && esPoligono(layer)){
    Acu.estiloSector(layer, aq.color || TIPOS.sector.color, aq.datos, sel);
    return;
  }
  Acu.quitarClasesSector(layer);
  const col = colorDe(aq);
  const sinAsignar = aq.tipo === 'sin';
  if (esPunto(layer)){
    const cerrada = aq.tipo === 'llave' && aq.datos.estado === 'cerrada';
    layer.setStyle({radius: aq.tipo === 'llave' ? 9 : 7, color: sel ? '#FFD23F' : (cerrada ? col : '#fff'),
      weight: sel ? 4 : (cerrada ? 3 : 2), fillColor: col, fillOpacity: cerrada ? 0.15 : 0.95, dashArray: sinAsignar ? '3 3' : null});
  } else if (esPoligono(layer)){
    layer.setStyle({color: sel ? '#FFD23F' : col, weight: sel ? 4 : 2, fillColor: col, opacity:1,
      fillOpacity: aq.tipo === 'casa' ? 0.45 : 0.2, dashArray: sinAsignar ? '5 5' : null});
  } else {
    const acometida = aq.tipo === 'tuberia' && aq.datos.clase === 'acometida';
    const grosor = aq.tipo === 'tuberia' ? (acometida ? 3 : 5) : 3;
    layer.setStyle({color: sel ? '#FFD23F' : col, weight: grosor + (sel ? 3 : 0),
      opacity: 0.95, lineCap:'round', dashArray: sinAsignar ? '7 7' : null});
  }
}
function ordenarSectores(){
  capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'sector' && l._map) l.bringToBack(); });
}
function titulo(aq){
  const d = aq.datos || {};
  if (aq.tipo === 'casa') return [d.numero ? 'Casa ' + d.numero : 'Casa', d.responsable].filter(Boolean).join(', ');
  if (aq.tipo === 'tuberia') return (d.clase === 'acometida' ? 'Acometida' : 'Tubería') + (d.nombre ? ' ' + d.nombre : '');
  if (aq.tipo === 'llave') return (d.nombre ? 'Llave ' + d.nombre : 'Llave') + (d.estado === 'cerrada' ? ' (cerrada)' : '');
  if (aq.tipo === 'sector') return d.nombre || 'Sector sin nombre';
  if (aq.tipo === 'conector') return 'Conector en ' + (d.forma === 'Y' ? 'Y' : 'T') + (d.nombre ? ': ' + d.nombre : '');
  return 'Forma sin función';
}
function textoIncidencias(id){
  const incs = incidenciasDe(id);
  return incs.length ? [...new Set(incs.map(i => i.tipo))].join(', ') : '';
}
function actualizarTooltip(layer){
  const aq = layer.aq;
  const inc = textoIncidencias(aq.id);
  if (aq.tipo === 'sector' && esPoligono(layer)){ Acu.ponerEtiquetaSector(layer, aq.datos, inc); return; }
  let t = esc(titulo(aq));
  if (aq.tipo === 'casa'){ const c = cuenta(aq); if (c.aplica) t += '<br>' + esc(textoEstado(c).txt); }
  if (inc) t += `<br><b style="color:${ROJO}">⚠ ${esc(inc)}</b>`;
  Acu.ponerTooltip(layer, t);
}

function prepararCapa(layer, aq){
  layer.aq = aq;
  layer.on('click', ev => {
    if (modoPunto){ L.DomEvent.stopPropagation(ev); tomarPunto(ev.latlng); return; }
    if (map.pm.globalRemovalModeEnabled && map.pm.globalRemovalModeEnabled()) return;
    if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) return;
    L.DomEvent.stopPropagation(ev);
    seleccionar(layer);
  });
  layer.on('pm:dragstart', () => { if (layer.aq.tipo === 'conector') layer._unidas = conexionesConector(layer); });
  layer.on('pm:drag', () => { if (layer.aq.tipo === 'conector') aplicarEstilo(layer); });
  layer.on('pm:dragend', () => {
    if (layer.aq.tipo === 'conector' && layer._unidas){ moverUnidas(layer, layer._unidas); layer._unidas = null; aplicarEstilo(layer); }
  });
  layer.on('pm:edit pm:dragend', () => {
    guardarForma(layer.aq.id); renderResumenPronto();
    geometriaCambio();
    if (selected === layer) renderPanel();
  });
  aplicarEstilo(layer);
  actualizarTooltip(layer);
}
function agregarCapa(layer, aq){
  if (!capa.hasLayer(layer)) capa.addLayer(layer);
  capas.set(aq.id, layer);
  prepararCapa(layer, aq);
  geometriaCambio();
}
function quitarCapaLocal(layer){
  if (selected === layer) cerrarPanel();
  if (layer._decor){ capaConectores.removeLayer(layer._decor); layer._decor = null; }
  capa.removeLayer(layer); map.removeLayer(layer);
  if (layer.aq) capas.delete(layer.aq.id);
  geometriaCambio();
}
function refrescarForma(layer){
  aplicarEstilo(layer); actualizarTooltip(layer);
  if (selected === layer){ actualizarTituloPanel(); refrescarCuenta(); }
  renderResumenPronto();
}
async function eliminarForma(layer){
  const id = layer.aq.id;
  quitarCapaLocal(layer);
  quitarIncidenciasDe(id);
  pendientes.delete(id);
  renderResumen();
  await tarea(sb.from('formas').delete().eq('id', id), 'No se pudo eliminar la forma');
}

/* =====================================================================
   RED DE TUBERÍAS
   El cálculo de la red está en comun.js y lo comparte el mapa público.
   ===================================================================== */
let redCache = null;
function elementosMapa(){
  const out = [];
  capa.eachLayer(l => { if (l.aq) out.push({id:l.aq.id, tipo:l.aq.tipo, datos:l.aq.datos, layer:l}); });
  return out;
}
function redActual(){
  if (!redCache || redCache.v !== versionGeo) redCache = {v:versionGeo, red:Acu.construirRed(elementosMapa())};
  return redCache.red;
}
function geometriaCambio(){ versionGeo++; recalcularPronto(); flechasPronto(); }

function redConectada(id){
  const l = capas.get(id);
  if (!l) return {tubos:new Set(), casas:new Set(), llaves:new Set()};
  return Acu.conectado(redActual(), id, l.aq.tipo);
}
function textoRed(r){
  const partes = [r.tubos.size === 1 ? '1 tramo' : `${r.tubos.size} tramos`, r.casas.size === 1 ? '1 casa' : `${r.casas.size} casas`];
  if (r.llaves.size) partes.push(r.llaves.size === 1 ? '1 llave' : `${r.llaves.size} llaves`);
  return partes.join(', ');
}
function puntoRepresentativo(l){
  if (esLinea(l)){ const pts = l.getLatLngs().flat(Infinity); return pts[Math.floor(pts.length / 2)]; }
  return Acu.centroDe(l);
}
function sectoresDe(layer){
  if (!layer) return [];
  return redActual().sectoresEn(puntoRepresentativo(layer)).filter(id => id !== layer.aq.id);
}
function listaSectores(){
  const out = [];
  capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'sector' && esPoligono(l)) out.push(l); });
  return out.sort((a, b) => String(a.aq.datos.nombre).localeCompare(String(b.aq.datos.nombre), 'es', {numeric:true}));
}

/* --- Flechas de dirección del agua (se ven de cerca, zoom 16 o más) --- */
const capaFlechas = L.layerGroup();
function dibujarFlechas(){ Acu.dibujarFlechas(map, elementosMapa(), capaFlechas); mostrarFlechasSegunZoom(); }
function mostrarFlechasSegunZoom(){
  const ver = map.getZoom() >= 16;
  if (ver && !map.hasLayer(capaFlechas)) capaFlechas.addTo(map);
  if (!ver && map.hasLayer(capaFlechas)) map.removeLayer(capaFlechas);
}
map.on('zoomend', mostrarFlechasSegunZoom);
const flechasPronto = debounce(dibujarFlechas, 400);

/* --- Inicio y final de la tubería seleccionada --- */
const capaSel = L.layerGroup().addTo(map);
function marcarExtremos(layer){
  capaSel.clearLayers();
  if (!layer || !layer.aq || layer.aq.tipo !== 'tuberia' || !esLinea(layer)) return;
  const partes = layer.getLatLngs(), pts = (Array.isArray(partes[0]) ? partes : [partes]).flat();
  if (pts.length < 2) return;
  const tag = t => L.divIcon({className:'extremo-tubo', html:`<span>${t}</span>`, iconSize:null});
  L.marker(pts[0], {icon:tag('Inicio'), interactive:false, keyboard:false, pmIgnore:true, snapIgnore:true}).addTo(capaSel);
  L.marker(pts[pts.length - 1], {icon:tag('Final'), interactive:false, keyboard:false, pmIgnore:true, snapIgnore:true}).addTo(capaSel);
}

/* =====================================================================
   INCIDENCIAS
   ===================================================================== */
map.createPane('incidencias').style.zIndex = 450;
const capaInc = L.layerGroup().addTo(map);    // lo afectado por incidencias abiertas
const capaTemp = L.layerGroup().addTo(map);   // vista previa mientras se crea una incidencia
let afectaciones = new Map();                  // id de incidencia -> resultado del cálculo
let tocados = new Map();                       // tuberías afectadas solo en parte o con un punto marcado
let borrador = null, modoPunto = null;

const origenDe = inc => { const o = capas.get(inc.forma_id); return o ? {id:o.aq.id, tipo:o.aq.tipo} : null; };
function afectacionDe(inc){
  if (!afectaciones.has(inc.id)) afectaciones.set(inc.id, Acu.afectacion(redActual(), inc, origenDe(inc)));
  return afectaciones.get(inc.id);
}
function afectadosPor(inc){ const r = afectacionDe(inc); return [...new Set([...r.formas, ...r.tubos])]; }
function incidenciasDe(id){
  const vistas = new Set(), out = [];
  [...(afectados.get(id) || []), ...(tocados.get(id) || [])].forEach(i => { if (!vistas.has(i.id)){ vistas.add(i.id); out.push(i); } });
  return out;
}
const propagaInc = inc => inc.propagar === true || (inc.propagar == null && inc.alcance === 'red');

function dibujarAfectacion(r, inc, grupo, vista){
  const col = inc.color || ROJO;
  const alTocar = (ev, ll) => { if (ev) L.DomEvent.stopPropagation(ev); if (modoPunto) return tomarPunto(ll); verIncidencia(inc); };
  r.piezas.forEach(p => {
    const pl = L.polyline(p.latlngs, {pane:'incidencias', color:col, weight:vista ? 6 : 7, opacity:vista ? .75 : .95,
      dashArray:vista ? '8 8' : null, lineCap:'round', className:vista ? '' : 'con-incidencia', pmIgnore:true, snapIgnore:true, interactive:!vista});
    if (!vista) pl.bindTooltip('⚠ ' + esc(inc.tipo), {sticky:true}).on('click', ev => alTocar(ev, ev.latlng));
    pl.addTo(grupo);
  });
  if (vista) r.formas.forEach(id => {
    const l = capas.get(id);
    if (l && esLinea(l)) L.polyline(l.getLatLngs(), {pane:'incidencias', color:col, weight:6, opacity:.75, dashArray:'8 8', pmIgnore:true, snapIgnore:true, interactive:false}).addTo(grupo);
  });
  r.puntos.forEach((ll, i) => {
    const txt = r.puntos.length > 1 ? (i ? 'B' : 'A') : '!';
    const mk = L.marker(ll, {icon:Acu.iconoIncidencia(txt), pmIgnore:true, snapIgnore:true, zIndexOffset:1000, interactive:!vista, keyboard:false});
    if (!vista) mk.bindTooltip('⚠ ' + esc(inc.tipo) + (r.puntos.length > 1 ? ` (punto ${txt})` : ''), {direction:'top', offset:[0,-14]})
      .on('click', ev => alTocar(ev, ev.latlng));
    mk.addTo(grupo);
  });
}

function recalcularIncidencias(){
  afectaciones = new Map();
  const antes = new Set([...afectados.keys(), ...tocados.keys()]);
  const nuevoA = new Map(), nuevoT = new Map();
  const poner = (m, id, inc) => { if (!m.has(id)) m.set(id, []); m.get(id).push(inc); };
  capaInc.clearLayers();
  (historico ? [historico] : incAbiertas()).forEach(inc => {
    const r = afectacionDe(inc);
    r.formas.forEach(id => poner(nuevoA, id, inc));
    r.tubos.forEach(id => { if (!r.formas.has(id)) poner(nuevoT, id, inc); });
    if (!r.formas.has(inc.forma_id) && !r.tubos.has(inc.forma_id)) poner(nuevoT, inc.forma_id, inc);
    dibujarAfectacion(r, inc, capaInc, false);
  });
  afectados = nuevoA; tocados = nuevoT;
  new Set([...antes, ...afectados.keys(), ...tocados.keys()]).forEach(id => {
    const l = capas.get(id);
    if (l){ aplicarEstilo(l); actualizarTooltip(l); }
  });
  renderIncidenciasLateral();
  if (selected){ actualizarTituloPanel(); if (!formIncAbierto) renderIncidenciasPanel(); }
  actualizarBadges();
}
const recalcularPronto = debounce(recalcularIncidencias, 300);

function quitarIncidenciasDe(formaId){
  [...incidencias.values()].forEach(i => { if (i.forma_id === formaId) incidencias.delete(i.id); });
  recalcularPronto();
}

function textoAlcance(inc){
  const o = capas.get(inc.forma_id);
  if (!o) return '';
  let donde = '';
  if (o.aq.tipo === 'tuberia'){
    const u = inc.ubicacion || 'completo';
    donde = u === 'punto' ? 'En un punto de la tubería' : u === 'tramo_ab' ? 'Entre los puntos A y B' : 'En toda la tubería';
    if (propagaInc(inc)) donde += ' y aguas abajo';
  } else if (o.aq.tipo === 'casa') donde = propagaInc(inc) ? 'La casa y su línea conectada' : 'Solo la casa';
  else donde = 'El sector';
  return donde + '. Marca en rojo: ' + Acu.textoAfectacion(afectacionDe(inc));
}

async function consultaConFila(consulta, msgError){
  enVuelo++; pintarSync();
  try {
    const {data, error} = await consulta;
    if (error) throw error;
    errorSync = null;
    return data;
  } catch (e){
    console.error(e);
    errorSync = e.message || String(e);
    aviso((msgError || 'No se pudo guardar') + '. ' + explicarError(e), 9000);
    if (explicarError(e) === MSG_BD_VIEJA) mostrarAlertaBD();
    return null;
  } finally { enVuelo--; pintarSync(); }
}

async function crearIncidencia(layer, d){
  await flush();   // el elemento debe existir en la base de datos
  const fila = await consultaConFila(sb.from('incidencias').insert({
    id:uid(), forma_id:layer.aq.id, tipo:d.tipo, detalle:d.detalle,
    ubicacion:d.ubicacion, punto_a:d.punto_a, punto_b:d.punto_b,
    propagar:d.propagar, sectores_enlazados:d.sectores_enlazados, sector_id:d.sector_id || null,
    alcance:d.propagar ? 'red' : (d.sector_id ? 'sector' : 'forma'),
    color:d.color, opacidad:d.opacidad, publica:d.publica !== false, detalle_publico:d.detalle_publico || null,
    estado:'abierta', editado_por:CLIENTE_ID
  }).select().single(), 'No se pudo crear la incidencia');
  if (!fila) return false;
  incidencias.set(fila.id, fila);
  recalcularIncidencias();
  aviso('Incidencia creada: ' + fila.tipo);
  return true;
}
async function actualizarIncidencia(id, cambios, msg){
  const fila = await consultaConFila(sb.from('incidencias').update({...cambios, editado_por:CLIENTE_ID}).eq('id', id).select().single(),
    'No se pudo actualizar la incidencia');
  if (!fila) return;
  incidencias.set(fila.id, fila);
  recalcularIncidencias();
  if (msg) aviso(msg);
}
/* Control administrativo: al resolver se indica quién atendió la incidencia */
function pedirResolucion(id){
  const inc = incidencias.get(id); if (!inc) return;
  const o = capas.get(inc.forma_id);
  $('#resTitulo').textContent = inc.tipo + (o ? ' · ' + titulo(o.aq) : '');
  const lista = adminsLista.filter(a => a.estado === 'activo');
  if (!lista.some(a => a.id === miPerfil.id)) lista.unshift(miPerfil);
  $('#resQuien').innerHTML = lista.map(a => `<option value="${esc(a.id)}" ${a.id === miPerfil.id ? 'selected' : ''}>${esc((a.nombre || 'Sin nombre') + (nombreCargo(a) ? ' — ' + nombreCargo(a) : ''))}${a.id === miPerfil.id ? ' (yo)' : ''}</option>`).join('');
  $('#resNota').value = '';
  $('#resConfirmar').onclick = async () => {
    $('#resConfirmar').disabled = true;
    await actualizarIncidencia(id, {estado:'resuelta', resuelta_en:new Date().toISOString(),
      atendida_por:$('#resQuien').value || null, nota_cierre:$('#resNota').value.trim() || null}, 'Incidencia resuelta y registrada.');
    $('#resConfirmar').disabled = false;
    $('#dlgResolver').close();
  };
  $('#dlgResolver').showModal();
}
/* Quién registró, resolvió y atendió (datos internos) */
function textoControl(inc){
  const filas = [];
  if (inc.creado_por_nombre) filas.push(`📝 Registró: <b>${esc(inc.creado_por_nombre)}</b>`);
  if (inc.estado === 'resuelta'){
    if (inc.atendida_por_nombre) filas.push(`🔧 Atendió: <b>${esc(inc.atendida_por_nombre)}</b>`);
    if (inc.resuelta_por_nombre && inc.resuelta_por_nombre !== inc.atendida_por_nombre) filas.push(`✅ Marcó como resuelta: <b>${esc(inc.resuelta_por_nombre)}</b>`);
    if (inc.nota_cierre) filas.push(`🗒 Nota de cierre: ${esc(inc.nota_cierre)}`);
  }
  return filas.length ? `<p class="control">${filas.join('<br>')}</p>` : '';
}

async function borrarIncidencias(ids){
  if (!esDev()){ aviso('Solo el desarrollador puede borrar el historial.'); return; }
  if (!ids.length) return;
  enVuelo++; pintarSync();
  const {data, error} = await sb.from('incidencias').delete().in('id', ids).select('id');
  enVuelo--; pintarSync();
  if (error){ aviso('No se pudo eliminar: ' + explicarError(error), 7000); return; }
  const borradas = (data || []).map(r => r.id);
  borradas.forEach(id => incidencias.delete(id));
  recalcularIncidencias();
  if (borradas.length < ids.length) aviso('Algunas no se borraron: solo el desarrollador puede borrar el historial.', 6000);
  else aviso(borradas.length === 1 ? 'Incidencia eliminada del historial.' : `${borradas.length} incidencias eliminadas del historial.`);
}
const borrarIncidencia = id => borrarIncidencias([id]);

/* --- Tipos de incidencia --- */
async function agregarTipoInc(nombre){
  nombre = (nombre || '').trim();
  if (!nombre) return null;
  const existe = tiposInc.find(t => t.nombre.toLowerCase() === nombre.toLowerCase());
  if (existe) return existe;
  const orden = tiposInc.reduce((m, t) => Math.max(m, t.orden || 0), 0) + 1;
  const fila = await consultaConFila(sb.from('tipos_incidencia').insert({id:uid(), nombre, orden}).select().single(),
    'No se pudo añadir el tipo de incidencia');
  if (!fila) return null;
  tiposInc.push(fila);
  renderTiposInc();
  return fila;
}
function renderTiposInc(){
  const ul = $('#listaTiposInc');
  if (!tiposInc.length){ ul.innerHTML = '<li class="vacio">No hay tipos. Añade uno abajo.</li>'; return; }
  ul.innerHTML = tiposInc.map(t => `<li><span>${esc(t.nombre)}</span><button class="x" data-borrar-tipo="${esc(t.id)}" aria-label="Quitar ${esc(t.nombre)}">×</button></li>`).join('');
  ul.querySelectorAll('[data-borrar-tipo]').forEach(b => b.addEventListener('click', async () => {
    const t = tiposInc.find(x => x.id === b.dataset.borrarTipo);
    if (!t || !confirm(`¿Quitar «${t.nombre}» de la lista? Las incidencias que ya lo usan no cambian.`)) return;
    const ok = await tarea(sb.from('tipos_incidencia').delete().eq('id', t.id), 'No se pudo quitar el tipo');
    if (ok){ tiposInc = tiposInc.filter(x => x.id !== t.id); renderTiposInc(); }
  }));
}
$('#agregarTipoInc').addEventListener('click', async () => {
  const f = await agregarTipoInc($('#nuevoTipoInc').value);
  if (f){ $('#nuevoTipoInc').value = ''; aviso('Tipo añadido: ' + f.nombre); }
});
$('#nuevoTipoInc').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); $('#agregarTipoInc').click(); } });

/* --- Resaltar temporalmente lo conectado --- */
function resaltarRed(layer){
  const r = redConectada(layer.aq.id);
  const ids = [...r.tubos, ...r.casas, ...r.llaves];
  if (!r.tubos.size){ aviso('Este elemento no está conectado a ninguna tubería.'); return; }
  const b = L.latLngBounds([]);
  ids.forEach(id => {
    const l = capas.get(id); if (!l) return;
    b.extend(l.getBounds ? l.getBounds() : l.getLatLng());
    if (esPunto(l)) l.setStyle({color:'#FFD23F', weight:4});
    else if (esPoligono(l)) l.setStyle({color:'#FFD23F', weight:4, fillColor:'#FFD23F', fillOpacity:.55});
    else l.setStyle({color:'#FFD23F', opacity:1});
  });
  if (b.isValid()) map.fitBounds(b, {maxZoom:19, padding:[60,60]});
  aviso('Conectado: ' + textoRed(r));
  setTimeout(() => ids.forEach(id => { const l = capas.get(id); if (l) aplicarEstilo(l); }), 2800);
}

/* --- Elegir un punto sobre la tubería tocando el mapa --- */
function elegirPunto(texto, alElegir){
  modoPunto = {alElegir};
  $('#panel').classList.remove('abierto');
  map.getContainer().classList.add('eligiendo-punto');
  $('#pista').textContent = `Toca sobre la tubería ${texto}. (Esc para cancelar)`;
  $('#pista').hidden = false;
}
function terminarModoPunto(reabrir = true){
  if (!modoPunto) return;
  modoPunto = null;
  map.getContainer().classList.remove('eligiendo-punto');
  if (!pendingTipo) $('#pista').hidden = true;
  if (reabrir && selected) $('#panel').classList.add('abierto');
}
function tomarPunto(latlng){
  const mpp = 40075016.686 * Math.cos(latlng.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
  const r = redActual().puntoMasCercano(latlng, Math.max(4, 22 * mpp));
  if (!r){ aviso('Toca justo sobre una tubería.'); return; }
  const cb = modoPunto.alElegir;
  terminarModoPunto(true);
  cb({lat:+r.latlng.lat.toFixed(7), lng:+r.latlng.lng.toFixed(7)});
}

/* --- Sección de incidencias dentro del panel --- */
function renderIncidenciasPanel(){
  const box = $('#incBox'); if (!box || !selected) return;
  const layer = selected, aq = layer.aq;
  const abiertas = incidenciasDe(aq.id);
  const historial = [...incidencias.values()]
    .filter(i => i.forma_id === aq.id && i.estado === 'resuelta')
    .sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en)));
  const tarjeta = inc => {
    const esOrigen = inc.forma_id === aq.id, origen = capas.get(inc.forma_id);
    return `<div class="inc ${inc.estado === 'resuelta' ? 'resuelta' : ''}">
      <div class="inc-cab"><b>${inc.estado === 'resuelta' ? '✓' : '⚠'} ${esc(inc.tipo)}</b></div>
      <p class="meta">Creada: ${esc(Acu.fechaHora(inc.creada_en))} (${esc(Acu.hace(inc.creada_en))})</p>
      ${inc.resuelta_en ? `<p class="meta">Resuelta: ${esc(Acu.fechaHora(inc.resuelta_en))}</p>` : ''}
      ${inc.detalle ? `<p>${esc(inc.detalle)}</p>` : ''}
      ${textoControl(inc)}
      <p class="meta">${inc.publica === false ? '🔒 Solo la ven los administradores' : '🌐 Visible al público' + (inc.detalle_publico ? ': «' + esc(inc.detalle_publico) + '»' : '')}</p>
      ${inc.estado === 'abierta' ? `<p class="meta">${esc(textoAlcance(inc))}</p>` : ''}
      ${!esOrigen && origen ? `<p class="meta">Reportada en: <button class="origen" data-ir="${esc(inc.forma_id)}">${esc(titulo(origen.aq))}</button></p>` : ''}
      ${inc.estado === 'abierta' || esDev() ? `<div class="acciones">
        ${inc.estado === 'abierta' ? `<button class="btn chico primario" data-resolver="${esc(inc.id)}">Marcar resuelta</button>` : ''}
        ${esDev() ? `<button class="btn chico peligro" data-borrar-inc="${esc(inc.id)}" title="Solo el desarrollador">Eliminar</button>` : ''}</div>` : ''}
    </div>`;
  };
  let html = abiertas.length ? abiertas.map(tarjeta).join('') : '<p class="nota" style="margin:4px 0">No hay incidencias abiertas aquí.</p>';
  html += `<div id="incFormBox"></div>
    <div class="fila" style="margin-top:8px"><button class="btn alerta" id="incNueva">⚠ Reportar incidencia</button></div>`;
  if (historial.length) html += `<details style="margin-top:10px"><summary>Historial (${historial.length})</summary>${historial.map(tarjeta).join('')}</details>`;
  box.innerHTML = html;
  box.querySelectorAll('[data-resolver]').forEach(b => b.addEventListener('click', () => pedirResolucion(b.dataset.resolver)));
  box.querySelectorAll('[data-borrar-inc]').forEach(b => b.addEventListener('click', () => {
    if (confirm('¿Eliminar esta incidencia del historial? No se puede deshacer.')) borrarIncidencia(b.dataset.borrarInc);
  }));
  box.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', () => {
    const l = capas.get(b.dataset.ir); if (l){ enfocar(l); seleccionar(l); }
  }));
  $('#incNueva').addEventListener('click', () => abrirFormIncidencia(layer));
}

function abrirFormIncidencia(layer){
  const aq = layer.aq, box = $('#incFormBox'); if (!box) return;
  formIncAbierto = true;
  $('#incNueva').hidden = true;
  borrador = {punto_a:null, punto_b:null};
  const esTubo = aq.tipo === 'tuberia', esCasa = aq.tipo === 'casa', esSector = aq.tipo === 'sector';
  const sectores = listaSectores();
  const propios = esSector ? [aq.id] : sectoresDe(layer);
  const casaConectada = esCasa && redConectada(aq.id).tubos.size > 0;
  const sinDireccion = esTubo && !['adelante', 'atras'].includes(aq.datos.flujo);
  const secsTubo = esTubo ? (aq.datos.sectores || []).map(id => capas.get(id)).filter(Boolean) : [];
  const nombreS = s => s.aq.datos.nombre || 'Sector sin nombre';
  const radio = (valor, tit, det, marcado) => `<label class="opcion"><input type="radio" name="incUbic" value="${valor}" ${marcado ? 'checked' : ''}><span>${tit}<small>${det}</small></span></label>`;
  const check = (id, tit, det, marcado, activo = true) =>
    `<label class="opcion ${activo ? '' : 'off'}"><input type="checkbox" id="${id}" ${marcado && activo ? 'checked' : ''} ${activo ? '' : 'disabled'}><span>${tit}<small>${det}</small></span></label>`;

  let html = `<div class="inc-form">
    <label class="campo"><span>Tipo de incidencia</span>
      <select id="incTipo">${tiposInc.map(t => `<option>${esc(t.nombre)}</option>`).join('')}<option value="__nuevo">＋ Añadir nuevo tipo…</option></select></label>
    <label class="campo"><span>Detalle interno (solo administradores)</span><textarea id="incDetalle" rows="3" placeholder="Qué pasó, dónde exactamente, quién lo reportó…"></textarea></label>`;
  if (esTubo) html += `
    <fieldset class="alcance"><legend>¿Dónde está el problema?</legend>
      ${radio('completo', 'En toda la tubería', 'Se marca la tubería completa.', true)}
      ${radio('punto', 'En un punto exacto', 'Tocas en el mapa el lugar del problema.')}
      ${radio('tramo_ab', 'Entre dos puntos (A → B)', 'Marcas dónde empieza y dónde termina.')}
    </fieldset>
    <div class="puntos-inc" id="incPuntos" hidden>
      <div class="fila-punto"><button type="button" class="btn chico" id="marcarA">📍 Marcar el punto</button><span class="nota" id="estadoA">Sin marcar</span></div>
      <div class="fila-punto" id="filaB" hidden><button type="button" class="btn chico" id="marcarB">📍 Marcar punto B</button><span class="nota" id="estadoB">Sin marcar</span></div>
    </div>`;
  if (!esSector) html += `
    <fieldset class="alcance"><legend>¿Qué más se marca en rojo?</legend>
      ${esTubo
        ? check('incProp', 'Lo que queda aguas abajo', sinDireccion
            ? 'Esta tubería no tiene definida la dirección del agua, así que se marcará toda la línea conectada.'
            : 'Tuberías, casas y llaves que reciben el agua después del problema.', true)
        : check('incProp', 'Toda la línea conectada a la casa', casaConectada ? 'Tuberías, casas y llaves unidas a esta casa.' : 'Esta casa no está conectada a ninguna tubería.', false, casaConectada)}
      ${esTubo ? check('incEnl', 'Los sectores enlazados', 'Sectores vinculados a las tuberías afectadas' +
            (secsTubo.length ? ': ' + esc(secsTubo.map(nombreS).join(', ')) + '.' : '. Esta tubería todavía no tiene sectores vinculados.'), secsTubo.length > 0) : ''}
      ${check('incOtro', esCasa ? 'Todo el sector' : 'Otro sector', sectores.length ? 'Se marca además del resto; lo demás sigue en rojo.' : 'Todavía no hay sectores dibujados.', false, sectores.length > 0)}
      ${sectores.length ? `<label class="campo" id="incSectorBox" hidden><span>Sector</span><select id="incSector">${sectores.map(s =>
        `<option value="${esc(s.aq.id)}" ${s.aq.id === (propios[0] || '') ? 'selected' : ''}>${esc(nombreS(s))}</option>`).join('')}</select></label>` : ''}
    </fieldset>`;
  html += `
    <fieldset class="alcance"><legend>Página pública</legend>
      ${check('incPublica', 'Mostrar a los vecinos', 'Aparece en el mapa y el calendario públicos, sin el detalle interno.', !esCasa)}
      <label class="campo" id="incDetPubBox"><span>Mensaje para los vecinos (opcional)</span><textarea id="incDetPub" rows="2" maxlength="500" placeholder="Ej. Estamos reparando una fuga; el servicio vuelve hoy en la tarde."></textarea></label>
    </fieldset>
    <p class="vista-previa" id="incVista"></p>
    <div class="dos">
      <label class="campo"><span>Color</span><input type="color" id="incColor" value="${ROJO}" style="width:100%;height:34px;padding:0;border:1px solid var(--linea);border-radius:7px"></label>
      <label class="campo"><span>Opacidad: <output id="incOpVal">75%</output></span><input type="range" id="incOp" min="10" max="100" step="5" value="75"></label>
    </div>
    <p class="nota">Se guardará la fecha y hora de creación automáticamente.</p>
    <div class="fila"><button class="btn alerta" id="incCrear">Crear incidencia</button><button class="btn" id="incCancelar">Cancelar</button></div>
  </div>`;
  box.innerHTML = html;

  const selTipo = $('#incTipo');
  let ultimoTipo = selTipo.value;
  selTipo.addEventListener('change', async () => {
    if (selTipo.value !== '__nuevo'){ ultimoTipo = selTipo.value; return; }
    const t = await agregarTipoInc(prompt('Nombre del nuevo tipo de incidencia:'));
    if (!t){ selTipo.value = ultimoTipo; return; }
    selTipo.innerHTML = tiposInc.map(x => `<option>${esc(x.nombre)}</option>`).join('') + '<option value="__nuevo">＋ Añadir nuevo tipo…</option>';
    selTipo.value = t.nombre; ultimoTipo = t.nombre;
  });

  const leer = () => {
    const otro = $('#incOtro') && $('#incOtro').checked && $('#incSector');
    return {
      ubicacion: esTubo ? ((box.querySelector('input[name="incUbic"]:checked') || {}).value || 'completo') : 'completo',
      punto_a: borrador.punto_a, punto_b: borrador.punto_b,
      propagar: !!($('#incProp') && $('#incProp').checked),
      sectores_enlazados: !!($('#incEnl') && $('#incEnl').checked),
      sector_id: esSector ? aq.id : (otro ? $('#incSector').value : null),
      color: $('#incColor').value, opacidad: Number($('#incOp').value) / 100,
      publica: $('#incPublica').checked, detalle_publico: $('#incDetPub').value.trim() || null
    };
  };
  const faltanPuntos = d => esTubo && ((d.ubicacion !== 'completo' && !d.punto_a) || (d.ubicacion === 'tramo_ab' && !d.punto_b));
  const actualizarVista = () => {
    if (!borrador) return;
    const d = leer();
    if (esTubo){
      $('#incPuntos').hidden = d.ubicacion === 'completo';
      $('#filaB').hidden = d.ubicacion !== 'tramo_ab';
      $('#marcarA').textContent = d.ubicacion === 'tramo_ab' ? '📍 Marcar punto A' : '📍 Marcar el punto';
      $('#estadoA').textContent = d.punto_a ? 'Marcado ✓' : 'Sin marcar';
      $('#estadoB').textContent = d.punto_b ? 'Marcado ✓' : 'Sin marcar';
    }
    const sBox = $('#incSectorBox'); if (sBox) sBox.hidden = !($('#incOtro') && $('#incOtro').checked);
    $('#incDetPubBox').hidden = !$('#incPublica').checked;
    capaTemp.clearLayers();
    if (faltanPuntos(d)){
      $('#incVista').textContent = d.ubicacion === 'tramo_ab' ? 'Marca en el mapa los puntos A y B.' : 'Marca en el mapa el lugar del problema.';
      if (d.punto_a) capaTemp.addLayer(L.marker(d.punto_a, {icon:Acu.iconoIncidencia(d.ubicacion === 'tramo_ab' ? 'A' : '!'), interactive:false, pmIgnore:true, snapIgnore:true}));
      return;
    }
    const r = Acu.afectacion(redActual(), d, {id:aq.id, tipo:aq.tipo});
    dibujarAfectacion(r, {tipo:'', color:d.color}, capaTemp, true);
    $('#incVista').innerHTML = `<b>Se marcará en rojo:</b> ${esc(Acu.textoAfectacion(r))}.<br><small>Vista previa punteada en el mapa.</small>`;
  };
  box.querySelectorAll('input, select').forEach(i => i.addEventListener('change', actualizarVista));
  $('#incOp').addEventListener('input', () => { $('#incOpVal').textContent = $('#incOp').value + '%'; });
  if (esTubo){
    $('#marcarA').addEventListener('click', () => {
      const ab = leer().ubicacion === 'tramo_ab';
      elegirPunto(ab ? 'donde empieza el problema (punto A)' : 'en el lugar exacto del problema', p => { if (borrador){ borrador.punto_a = p; actualizarVista(); } });
    });
    $('#marcarB').addEventListener('click', () => elegirPunto('donde termina el problema (punto B)', p => { if (borrador){ borrador.punto_b = p; actualizarVista(); } }));
  }
  const cerrarForm = () => { formIncAbierto = false; borrador = null; capaTemp.clearLayers(); terminarModoPunto(false); renderIncidenciasPanel(); };
  $('#incCancelar').addEventListener('click', cerrarForm);
  $('#incCrear').addEventListener('click', async () => {
    const d = leer();
    if (!selTipo.value || selTipo.value === '__nuevo'){ aviso('Elige el tipo de incidencia.'); return; }
    if (faltanPuntos(d)){ aviso(d.ubicacion === 'tramo_ab' ? 'Marca los puntos A y B en el mapa.' : 'Marca en el mapa el lugar del problema.'); return; }
    const btn = $('#incCrear'); btn.disabled = true;
    const ok = await crearIncidencia(layer, {...d, tipo:selTipo.value, detalle:$('#incDetalle').value.trim()});
    if (ok) cerrarForm(); else btn.disabled = false;
  });
  actualizarVista();
  setTimeout(() => $('#incDetalle') && $('#incDetalle').focus(), 50);
}

/* --- Al cambiar las incidencias se actualiza la sección visible --- */
function renderIncidenciasLateral(){ renderResumenPronto(); }

/* Encender o apagar el flujo de agua de un sector */
function ponerFlujo(layer, activo){
  const d = layer.aq.datos;
  if (!!d.activo === activo) return;
  d.activo = activo;
  d.activoDesde = new Date().toISOString();
  refrescarForma(layer);
  guardarForma(layer.aq.id, true);
  if (selected === layer) renderPanel();
  aviso(`${d.nombre || 'Sector'}: ${activo ? 'con agua' : 'sin agua'}`);
}

/* =====================================================================
   CONECTORES EN T / Y, RAMALES Y TRAZADOS GUIADOS
   ===================================================================== */
const COLOR_CONECTOR = '#0B5C73';
const capaConectores = L.layerGroup().addTo(map);   // dibujo de los brazos (no se puede tocar)
map.on('zoomend', () => conectores().forEach(aplicarEstilo));   // de cerca se ven los números de los brazos
const TAMANO_UNION = 1.5;                           // m: largo de cada brazo de una unión nueva
const radioConector = c => Acu.tamanoConector(c.aq.datos) + 4;   // m: una punta tan cerca se une sola a la unión

const conectores = () => [...capas.values()].filter(l => l.aq && l.aq.tipo === 'conector');
const tuberias = () => [...capas.values()].filter(l => l.aq && l.aq.tipo === 'tuberia' && esLinea(l));
function puntosDe(l){ const ll = l.getLatLngs(); return (Array.isArray(ll[0]) ? ll[0] : ll).slice(); }
function ponerPuntos(l, pts){ const ll = l.getLatLngs(); if (Array.isArray(ll[0])){ ll[0] = pts; l.setLatLngs(ll); } else l.setLatLngs(pts); }
function extremos(l){ const p = puntosDe(l); return {ini:p[0], fin:p[p.length - 1]}; }

/* Puntas de los conectores, para que el trazo "se pegue" a ellas al dibujar */
function puertosParaUnir(){
  const out = [];
  conectores().forEach(c => Acu.puertosConector(c.getLatLng(), c.aq.datos).todos.forEach(p => out.push(L.circleMarker(p, {radius:4, pmIgnore:true}))));
  return out;
}
/* Qué tubería está en cada puerto: [entrada, salida1, salida2] */
function conexionesConector(con, puertos){
  const pr = puertos || Acu.puertosConector(con.getLatLng(), con.aq.datos);
  return pr.todos.map(p => {
    for (const t of tuberias()){
      const e = extremos(t);
      const tol = Acu.tolPuerto(con.aq.datos);
      if (e.ini.distanceTo(p) <= tol) return {layer:t, extremo:'ini'};
      if (e.fin.distanceTo(p) <= tol) return {layer:t, extremo:'fin'};
    }
    return null;
  });
}
/* Une las puntas de una tubería al conector más cercano y ajusta la dirección del agua */
function ajustarAConectores(tubo){
  if (!tubo || !esLinea(tubo) || !tubo.aq) return '';
  const pts = puntosDe(tubo), d = tubo.aq.datos, msgs = [];
  let cambio = false;
  ['ini', 'fin'].forEach(ext => {
    const i = ext === 'ini' ? 0 : pts.length - 1, p = pts[i];
    let mejor = null;
    conectores().forEach(c => { const dist = c.getLatLng().distanceTo(p); if (dist <= radioConector(c) && (!mejor || dist < mejor.dist)) mejor = {c, dist}; });
    if (!mejor) return;
    const pr = Acu.puertosConector(mejor.c.getLatLng(), mejor.c.aq.datos);
    const ocupados = conexionesConector(mejor.c, pr).map(x => x && x.layer !== tubo);
    const orden = pr.todos.map((q, k) => ({k, dist:q.distanceTo(p)})).sort((a, b) => a.dist - b.dist);
    const libre = orden.find(o => !ocupados[o.k]);
    if (!libre){ msgs.push('Todas las puntas de ese conector ya están ocupadas.'); return; }
    pts[i] = pr.todos[libre.k];
    cambio = true;
    if (pr.entradaIdx === null){ msgs.push(`Unida al brazo ${libre.k + 1} de la unión.`); return; }
    d.flujo = flujoEnPuerto(ext, libre.k === pr.entradaIdx);
    msgs.push(`Unida al brazo ${libre.k + 1} (${libre.k === pr.entradaIdx ? 'entrada' : 'salida'}); dirección del agua ajustada.`);
  });
  if (cambio){ ponerPuntos(tubo, pts); guardarForma(tubo.aq.id); geometriaCambio(); aplicarEstilo(tubo); }
  return msgs.join(' ');
}
/* Entrada: el agua va hacia la unión. Salida: el agua sale de la unión. */
const flujoEnPuerto = (extremo, esEntrada) => (extremo === 'fin') === esEntrada ? 'adelante' : 'atras';
/* Cambia forma, giro, tamaño, lado o entrada de una unión llevando consigo las tuberías unidas */
function cambiarConector(con, cambios, soloVista){
  const antes = Acu.puertosConector(con.getLatLng(), con.aq.datos);
  const unidas = conexionesConector(con, antes);
  Object.assign(con.aq.datos, cambios);
  moverUnidas(con, unidas);
  // La entrada decide la dirección del agua de todas las tuberías unidas
  const e = Acu.entradaConector(con.aq.datos);
  if ('entrada' in cambios || e !== null) unidas.forEach((u, k) => {
    if (!u || e === null) return;
    const f = flujoEnPuerto(u.extremo, k === e);
    if (u.layer.aq.datos.flujo !== f){ u.layer.aq.datos.flujo = f; guardarForma(u.layer.aq.id); aplicarEstilo(u.layer); }
  });
  aplicarEstilo(con);
  if (!soloVista){ guardarForma(con.aq.id); geometriaCambio(); if (selected === con) renderPanel(); }
}
function moverUnidas(con, unidas){
  const ahora = Acu.puertosConector(con.getLatLng(), con.aq.datos).todos;
  unidas.forEach((u, k) => {
    if (!u) return;
    const pts = puntosDe(u.layer);
    pts[u.extremo === 'ini' ? 0 : pts.length - 1] = ahora[k];
    ponerPuntos(u.layer, pts);
    guardarForma(u.layer.aq.id);
  });
}
/* Al colocar un conector sobre una tubería, la corta en dos y la orienta con el agua */
function colocarConector(con){
  const ll = con.getLatLng(), d = con.aq.datos;
  const r = redActual().puntoMasCercano(ll, 6);
  const tubo = r && capas.get(r.arista.tubo);
  if (!tubo || Array.isArray(tubo.getLatLngs()[0])){
    aviso('Conector colocado. Gíralo desde el panel y une las tuberías a sus puntas.', 5000);
    return;
  }
  const pts = puntosDe(tubo);          // se respeta el orden del trazo y su dirección del agua
  const B = Acu.tamanoConector(d);
  // tramo más cercano y punto sobre él
  const cos = Math.cos(ll.lat * Math.PI / 180), m = q => ({x:q.lng * 111320 * cos, y:q.lat * 110540});
  let mejor = null;
  for (let i = 1; i < pts.length; i++){
    const a = m(pts[i - 1]), b = m(pts[i]), p = m(ll), dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const dist = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
    if (!mejor || dist < mejor.dist) mejor = {i, t, dist, ang:Math.atan2(dy, dx) * 180 / Math.PI};
  }
  const A0 = pts[mejor.i - 1], B0 = pts[mejor.i];
  const P = L.latLng(A0.lat + (B0.lat - A0.lat) * mejor.t, A0.lng + (B0.lng - A0.lng) * mejor.t);
  d.rotacion = Math.round((mejor.ang + 360) % 360);
  con.setLatLng(P);
  // Cerca de una punta: no se corta, solo se une esa punta
  const largoHasta = k => { let s = 0; for (let j = 1; j <= k; j++) s += pts[j - 1].distanceTo(pts[j]); return s; };
  const total = largoHasta(pts.length - 1), antes = largoHasta(mejor.i - 1) + A0.distanceTo(P);
  if (antes < B + 1 || total - antes < B + 1){
    if (total - antes < B + 1) d.rotacion = Math.round((d.rotacion + 180) % 360);   // el brazo 1 mira hacia la tubería
    aplicarEstilo(con); guardarForma(con.aq.id);
    ajustarAConectores(tubo);
    aviso('Unión colocada en la punta de la tubería. Elige en el panel por cuál brazo entra el agua.', 6000);
    return;
  }
  const pr = Acu.puertosConector(P, d);
  const parteA = pts.slice(0, mejor.i), parteB = pts.slice(mejor.i);
  while (parteA.length > 1 && parteA[parteA.length - 1].distanceTo(P) < B + 0.3) parteA.pop();
  while (parteB.length > 1 && parteB[0].distanceTo(P) < B + 0.3) parteB.shift();
  parteA.push(pr.todos[0]); parteB.unshift(pr.todos[1]);
  ponerPuntos(tubo, parteA);
  const datos = JSON.parse(JSON.stringify(tubo.aq.datos));
  datos.nombre = datos.nombre ? datos.nombre + ' (continuación)' : '';
  const nueva = L.polyline(parteB);
  agregarCapa(nueva, {id:uid(), tipo:'tuberia', color:Acu.COLOR_TUBERIA, colorManual:false, datos});
  aplicarEstilo(con); aplicarEstilo(tubo);
  guardarForma(tubo.aq.id); guardarForma(nueva.aq.id); guardarForma(con.aq.id);
  geometriaCambio();
  aviso('Unión colocada y tubería dividida. Ahora elige en el panel por cuál brazo entra el agua.', 7000);
}

/* ---------- Trazados guiados ----------
   ramal:    desde un punto de la tubería seleccionada hacia una casa u otro lugar
   casaCasa: de la casa seleccionada a otra casa (el agua sigue de una a otra)
   acometida: de una tubería a la casa seleccionada
   salida / entrada: desde o hacia una punta libre de un conector */
let trazado = null;
const PISTAS_TRAZADO = {
  ramal:'Toca sobre la tubería donde nace el ramal y luego ve tocando hasta la casa. Toca el último punto otra vez para terminar.',
  casaCasa:'El trazo ya empieza en esta casa: ve tocando hasta la casa que recibe el agua y toca el último punto otra vez.',
  acometida:'Empieza tocando sobre la tubería y termina dentro de la casa. Toca el último punto otra vez para terminar.',
  salida:'El trazo empieza en el brazo de la unión: ve tocando el camino y toca el último punto otra vez para terminar.',
  entrada:'Empieza donde viene el agua y termina en la punta del brazo de entrada de la unión.'
};
function centroCasa(l){ return esPunto(l) ? l.getLatLng() : l.getBounds().getCenter(); }
function dentroDe(ll, pol){
  let a = pol.getLatLngs(); while (Array.isArray(a[0])) a = a[0];
  let dentro = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++){
    if ((a[i].lat > ll.lat) !== (a[j].lat > ll.lat) && ll.lng < (a[j].lng - a[i].lng) * (ll.lat - a[i].lat) / (a[j].lat - a[i].lat) + a[i].lng) dentro = !dentro;
  }
  return dentro;
}
function casaEn(ll, excluir){
  return [...capas.values()].find(l => l.aq && l.aq.tipo === 'casa' && l.aq.id !== excluir &&
    (esPunto(l) ? l.getLatLng().distanceTo(ll) < 5 : dentroDe(ll, l))) || null;
}
function iniciarTrazado(tipo, origen, puntoInicial){
  asegurarMapa();
  terminarEdicion();
  map.pm.disableDraw();
  cerrarPanel();
  trazado = {tipo, origenId:origen.aq.id};
  pendingTipo = 'tuberia';
  map.pm.enableDraw('Line', {snappable:true});
  map.pm.Draw.Line._otherSnapLayers = puertosParaUnir();
  if (puntoInicial){
    const dib = map.pm.Draw.Line;
    dib._hintMarker._snapped = false;
    dib._createVertex({latlng:puntoInicial});
  }
  marcarBotones();
  cerrarLateralMovil();
}
function completarTrazado(layer, tr){
  const origen = capas.get(tr.origenId), d = layer.aq.datos, pts = puntosDe(layer);
  const nombreCorto = l => l ? (l.aq.datos.numero ? 'casa ' + l.aq.datos.numero : titulo(l.aq).toLowerCase()) : '';
  const destino = casaEn(pts[pts.length - 1], tr.tipo === 'casaCasa' ? tr.origenId : null);
  let msg = '';
  if (tr.tipo === 'ramal' && origen){
    const r = redActual().puntoMasCercano(pts[0], 15, origen.aq.id);
    if (r){ pts[0] = r.latlng; msg = 'Ramal creado desde ' + titulo(origen.aq) + '.'; }
    else msg = 'El ramal no empieza sobre la tubería: muévelo con «Mover puntos».';
    d.nombre = 'Ramal' + (origen.aq.datos.nombre ? ' de ' + origen.aq.datos.nombre : '');
    d.sectores = [...(origen.aq.datos.sectores || [])];
  }
  if (tr.tipo === 'casaCasa' && origen){
    pts[0] = centroCasa(origen);
    d.nombre = 'De ' + nombreCorto(origen) + (destino ? ' a ' + nombreCorto(destino) : '');
    msg = destino ? `Listo: el agua pasa de ${nombreCorto(origen)} a ${nombreCorto(destino)}.` : 'El trazo no termina dentro de otra casa: ajústalo con «Mover puntos».';
  }
  if (tr.tipo === 'acometida') msg = destino ? 'Acometida creada y unida a la casa.' : 'Revisa que la acometida termine dentro de la casa.';
  if (destino || tr.tipo === 'casaCasa' || tr.tipo === 'acometida'){ d.clase = 'acometida'; d.diametro = d.diametro || '1/2'; }
  if (destino && esPunto(destino)) pts[pts.length - 1] = destino.getLatLng();
  d.flujo = 'adelante';
  ponerPuntos(layer, pts);
  return msg;
}

/* ================= Dibujo ================= */
function iniciarDibujo(t){
  asegurarMapa();
  salirHistorico();
  if (pendingTipo === t){ map.pm.disableDraw(); pendingTipo = null; marcarBotones(); return; }
  map.pm.disableDraw();
  pendingTipo = t;
  trazado = null;
  map.pm.enableDraw(t.startsWith('conector') ? 'CircleMarker' : TIPOS[t].dibujo, {snappable:true});
  if (t === 'tuberia') map.pm.Draw.Line._otherSnapLayers = puertosParaUnir();
  marcarBotones();
  cerrarLateralMovil();
}
document.querySelectorAll('[data-dibujar]').forEach(b => b.addEventListener('click', () => iniciarDibujo(b.dataset.dibujar)));
function marcarBotones(){
  document.querySelectorAll('[data-dibujar]').forEach(b => b.classList.toggle('activo', b.dataset.dibujar === pendingTipo));
  $('#pista').textContent = pendingTipo ? (trazado ? PISTAS_TRAZADO[trazado.tipo] : PISTAS[pendingTipo]) + ' (Esc para cancelar)' : '';
  $('#pista').hidden = !pendingTipo;
}
map.on('pm:drawend', () => setTimeout(() => { if (!map.pm.globalDrawModeEnabled()){ pendingTipo = null; trazado = null; marcarBotones(); } }, 0));

map.on('pm:create', e => {
  const layer = e.layer;
  let tipo = pendingTipo || 'sin';
  const tr = trazado; trazado = null;
  const formaConector = tipo === 'conectorT' ? 'T' : tipo === 'conectorY' ? 'Y' : null;
  if (formaConector) tipo = esPunto(layer) ? 'conector' : 'sin';
  if (tipo === 'sector' && !esPoligono(layer)) tipo = 'sin';
  if (tipo === 'tuberia' && !esLinea(layer)) tipo = 'sin';
  const aq = {id:uid(), tipo, color:TIPOS[tipo].color, colorManual:false, datos:datosBase(tipo)};
  if (tipo === 'tuberia') aq.datos.flujo = 'adelante';
  if (tipo === 'conector') aq.datos.forma = formaConector;
  agregarCapa(layer, aq);
  let msg = '';
  if (tipo === 'tuberia'){
    if (tr) msg = completarTrazado(layer, tr);
    const union = ajustarAConectores(layer);
    if (union) msg = (msg ? msg + ' ' : '') + union;
    const cruza = redActual().sectoresQueCruza(layer);
    aq.datos.sectores = [...new Set([...(aq.datos.sectores || []), ...cruza])];
    geometriaCambio();
  }
  if (tipo === 'conector'){ map.pm.disableDraw(); pendingTipo = null; marcarBotones(); colocarConector(layer); }
  guardarForma(aq.id);
  renderResumen();
  seleccionar(layer);
  if (tipo === 'sin') aviso('Forma creada. Elige su función en el panel.');
  if (msg) aviso(msg, 6000);
  if (tipo === 'sector') setTimeout(() => { const n = document.querySelector('#pCuerpo [data-k="nombre"]'); if (n) n.focus(); }, 250);
});
map.on('pm:remove', e => { if (e.layer && e.layer.aq) eliminarForma(e.layer); });
map.on('click', e => {
  if (modoPunto){ tomarPunto(e.latlng); return; }
  if (map.pm.globalDrawModeEnabled && map.pm.globalDrawModeEnabled()) return;
  if (editando) return;
  if (selected) cerrarPanel();
});

/* ================= Selección y panel ================= */
function seleccionar(layer){
  asegurarMapa();
  salirHistorico();
  if (editando && editando !== layer) terminarEdicion();
  const prev = selected;
  selected = layer;
  if (prev && prev !== layer) aplicarEstilo(prev);
  aplicarEstilo(layer);
  if (!esPunto(layer) && layer.aq.tipo !== 'sector') layer.bringToFront();
  renderPanel();
  $('#panel').classList.add('abierto');
  cerrarLateralMovil();
}
function cerrarPanel(){
  terminarEdicion();
  terminarModoPunto(false);
  formIncAbierto = false; borrador = null;
  capaTemp.clearLayers(); capaSel.clearLayers();
  const prev = selected; selected = null;
  if (prev) aplicarEstilo(prev);
  $('#panel').classList.remove('abierto');
}
$('#pCerrar').addEventListener('click', cerrarPanel);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (historico){ salirHistorico(); return; }
  if (modoPunto){ terminarModoPunto(true); return; }
  if (pendingTipo){ map.pm.disableDraw(); pendingTipo = null; trazado = null; marcarBotones(); return; }
  if (editando){ terminarEdicion(); return; }
  cerrarPanel();
});

function enfocar(layer){
  asegurarMapa();
  if (esPunto(layer)) map.setView(layer.getLatLng(), Math.max(map.getZoom(), 18));
  else map.fitBounds(layer.getBounds(), {maxZoom:19, padding:[60,60]});
}

/* =====================================================================
   PANEL DE DETALLES
   Barra de acciones rápidas, recuadro de estado, pestañas y "Más opciones".
   ===================================================================== */
const tabActivo = {};                     // pestaña elegida por tipo de forma
const NOMBRE_TAB = {datos:'Datos', agua:'Agua', cuotas:'Cuotas', inc:'Incidencias'};
const TABS_DE = {casa:['datos','cuotas','inc'], tuberia:['datos','agua','inc'], sector:['datos','inc'], llave:['datos'], conector:['datos'], sin:[]};

function campo(label, k, val, type = 'text', extra = ''){
  return `<label class="campo"><span>${label}</span><input data-k="${k}" type="${type}" value="${esc(val)}" ${extra}></label>`;
}
const areaNotas = val => `<label class="campo"><span>Notas</span><textarea data-k="notas" rows="2">${esc(val)}</textarea></label>`;
const accion = (id, icono, texto, extra = '') => `<button class="p-acc" id="${id}" ${extra}><span aria-hidden="true">${icono}</span>${texto}</button>`;

function renderPanel(){
  if (!selected) return;
  const layer = selected, aq = layer.aq, d = aq.datos;
  actualizarTituloPanel();
  const tabs = TABS_DE[aq.tipo] || [];
  if (!tabs.includes(tabActivo[aq.tipo])) tabActivo[aq.tipo] = tabs[0];
  const nInc = incidenciasDe(aq.id).length;

  /* --- Acciones rápidas --- */
  const editandoEsta = editando === layer;
  let acciones = accion('pCentrar', '◎', 'Centrar');
  acciones += accion('pEditar', editandoEsta ? '✓' : '✥',
    editandoEsta ? 'Listo' : (esPunto(layer) ? 'Mover' : 'Mover puntos'), editandoEsta ? 'class="p-acc on"' : '');
  if (aq.tipo === 'tuberia') acciones += accion('pRamal', '⑂', 'Sacar ramal');
  if (aq.tipo === 'casa') acciones += accion('pCasaCasa', '➜', 'Llevar agua a otra casa');

  /* --- Estado resumido --- */
  let estado = '';
  if (aq.tipo === 'tuberia'){
    const r = redConectada(aq.id), unida = r.tubos.size > 1 || r.casas.size;
    const dir = d.flujo === 'adelante' ? 'Inicio → Final' : d.flujo === 'atras' ? 'Final → Inicio' : 'sin definir';
    estado = `<div class="p-estado ${unida ? '' : 'aviso'}">
      <p>${unida ? '🔗 Unida a ' + esc(textoRed(r)) : '⚠ No está unida a otras tuberías ni casas.'}</p>
      <p>💧 Dirección del agua: <b>${dir}</b>${d.clase === 'acometida' ? ' · Acometida' : ''}</p>
      <div class="fila"><button class="btn chico" id="verRed">Resaltar lo conectado</button></div></div>`;
  } else if (aq.tipo === 'casa'){
    const r = redConectada(aq.id), est = textoEstado(cuenta(aq));
    estado = `<div class="p-estado ${r.tubos.size ? '' : 'aviso'}">
      <p>${r.tubos.size ? '🔗 Recibe agua: ' + esc(textoRed(r)) : '⚠ No está conectada a ninguna tubería.'}</p>
      <p>💵 Cuenta: <span class="pill ${est.cls}">${esc(est.txt)}</span></p>
      <div class="fila">${r.tubos.size ? '<button class="btn chico" id="verRed">Resaltar lo conectado</button>' : ''}
        <button class="btn chico ${r.tubos.size ? '' : 'primario'}" id="conectarCasa">${r.tubos.size ? 'Otra acometida' : 'Conectar a una tubería'}</button></div></div>`;
  } else if (aq.tipo === 'sector'){
    estado = `<div class="p-estado">
      <label class="interruptor grande"><input type="checkbox" id="secFlujo" ${d.activo ? 'checked' : ''}><span class="riel"></span><span>${d.activo ? 'Con agua ahora' : 'Sin agua ahora'}</span></label>
      <p class="nota">${esc(d.activoDesde ? (d.activo ? 'Con agua ' : 'Sin agua ') + Acu.desde(d.activoDesde) + '.' : 'Aún no se ha cambiado el estado.')} Se ve en vivo en la página pública.</p></div>`;
  } else if (aq.tipo === 'llave'){
    estado = `<div class="p-estado"><div class="segmento" role="group" aria-label="Estado de la llave">
      <button data-estado="abierta" class="${d.estado !== 'cerrada' ? 'on' : ''}">Abierta</button>
      <button data-estado="cerrada" class="${d.estado === 'cerrada' ? 'on' : ''}">Cerrada</button></div></div>`;
  } else if (aq.tipo === 'conector'){
    const con = conexionesConector(layer), ent = Acu.entradaConector(d);
    const nombres = d.forma === 'Y' ? ['Tronco', 'Rama', 'Rama'] : ['Recto', 'Recto', 'Lateral'];
    const fila = i => {
      const t = con[i], esEnt = ent === i;
      return `<li class="${esEnt ? 'es-entrada' : ''}"><span class="puerto ${esEnt ? 'ent' : ''}">${i + 1}</span>
        <span class="nom">Brazo ${i + 1} <small class="lado">${nombres[i]}</small>
          <small>${ent === null ? '' : esEnt ? '💧 Entrada · ' : 'Salida · '}${t ? esc(titulo(t.layer.aq)) : 'libre'}</small></span>
        <span class="botones">${esEnt ? '' : `<button class="btn chico" data-entrada="${i}" title="El agua entra por este brazo; los otros dos quedan como salidas">Entrada</button>`}
        ${t ? `<button class="btn chico" data-ir="${esc(t.layer.aq.id)}">Ver</button>` : `<button class="btn chico" data-desde-puerto="${i}">Conectar</button>`}</span></li>`;
    };
    estado = `<div class="p-estado ${ent === null ? 'aviso' : ''}">
      <p>${ent === null ? '⚠ <b>Elige por cuál brazo entra el agua.</b> Los otros dos quedarán como salidas y la dirección del agua de las tuberías unidas se ajusta sola.'
                        : `💧 El agua entra por el brazo ${ent + 1} y sale por los otros dos.`}</p>
      <ul class="puertos">${[0, 1, 2].map(fila).join('')}</ul>
      ${ent === null ? '' : '<button class="btn chico" id="quitarEntrada">Quitar la entrada</button>'}
      <p class="nota">En el mapa, cada brazo muestra su número; «E» es la entrada y «S» las salidas.</p></div>`;
  } else {
    estado = `<div class="p-estado aviso"><p>Esta forma todavía no tiene función. Elige qué es:</p>${botonesTipo(layer)}</div>`;
  }

  /* --- Pestañas --- */
  const pestañas = {};
  if (aq.tipo === 'casa'){
    pestañas.datos = `
      <div class="dos">${campo('Número de casa','numero',d.numero)}${campo('Teléfono','telefono',d.telefono,'tel')}</div>
      ${campo('Responsable de la casa','responsable',d.responsable)}
      <div class="dos">${campo('Núcleos familiares','nucleos',d.nucleos,'number','min="0" step="1"')}${campo('Personas','personas',d.personas,'number','min="0" step="1"')}</div>
      ${areaNotas(d.notas)}`;
    pestañas.cuotas = `
      <div class="cuenta" id="cuentaBox"></div>
      <div class="dos">${campo('Cobrar desde','inicioCobro',d.inicioCobro,'month')}${campo('Deuda anterior','deudaAnterior',d.deudaAnterior,'number','min="0" step="0.01" placeholder="0.00"')}</div>
      <label class="campo"><span>Cuota mensual especial (opcional)</span><input data-k="cuotaEspecial" type="number" min="0" step="0.01" value="${esc(d.cuotaEspecial)}" id="inCuotaEsp"></label>
      <h4>Registrar pago</h4>
      <div class="pago-form">
        <label class="campo" style="margin:0"><span>Fecha</span><input type="date" id="pgFecha" value="${hoyISO()}"></label>
        <label class="campo" style="margin:0"><span>Monto</span><input type="number" id="pgMonto" min="0" step="0.01"></label>
        <label class="campo ancho" style="margin:0"><span>Detalle</span><input type="text" id="pgNota" placeholder="Ej. cuota de septiembre"></label>
        <button class="btn primario ancho" id="pgAgregar">Registrar pago</button>
      </div>
      <ul class="pagos" id="listaPagos"></ul>`;
  } else if (aq.tipo === 'tuberia'){
    const m = longitud(layer), materiales = ['PVC','PEAD / polietileno','Hierro galvanizado','Otro'];
    pestañas.datos = `
      ${campo('Nombre o tramo','nombre',d.nombre,'text','placeholder="Ej. Línea principal"')}
      <label class="campo"><span>Clase</span><select data-k="clase">
        <option value="principal" ${d.clase !== 'acometida' ? 'selected' : ''}>Línea principal</option>
        <option value="acometida" ${d.clase === 'acometida' ? 'selected' : ''}>Acometida (conexión a una casa)</option></select></label>
      <div class="dos">${campo('Diámetro (pulgadas)','diametro',d.diametro,'text','placeholder="Ej. 2"')}
        <label class="campo"><span>Material</span><select data-k="material">${materiales.map(x => `<option ${x === d.material ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
      ${m ? `<p class="nota">Largo aproximado: <b>${m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m'}</b></p>` : ''}
      ${areaNotas(d.notas)}`;
    const secs = listaSectores();
    pestañas.agua = `
      <label class="campo"><span>Dirección del agua</span></label>
      <div class="segmento" role="group" aria-label="Dirección del agua">
        <button data-flujo="" class="${!['adelante','atras'].includes(d.flujo) ? 'on' : ''}">Sin definir</button>
        <button data-flujo="adelante" class="${d.flujo === 'adelante' ? 'on' : ''}">Inicio → Final</button>
        <button data-flujo="atras" class="${d.flujo === 'atras' ? 'on' : ''}">Final → Inicio</button></div>
      <p class="nota">Mira las etiquetas «Inicio» y «Final» en el mapa. Las flechas se ven al acercarte.</p>
      <label class="campo"><span>Sectores que abastece</span></label>
      ${secs.length ? `<div class="checks-sectores">${secs.map(s => `
        <label class="check"><input type="checkbox" data-sector-tubo="${esc(s.aq.id)}" ${(d.sectores || []).includes(s.aq.id) ? 'checked' : ''}>
          <span><i class="muestra" style="background:${esc(s.aq.color || TIPOS.sector.color)}"></i>${esc(s.aq.datos.nombre || 'Sector sin nombre')}</span></label>`).join('')}</div>`
        : '<p class="nota">Todavía no hay sectores dibujados.</p>'}`;
  } else if (aq.tipo === 'sector'){
    const op = Math.round(Acu.opacidadSector(d) * 100);
    pestañas.datos = `
      ${campo('Nombre del sector o zona','nombre',d.nombre,'text','placeholder="Ej. Sector La Loma"')}
      <label class="campo"><span>Opacidad del relleno: <output id="opVal">${op}%</output></span>
        <input type="range" id="opRange" min="5" max="90" step="5" value="${op}"></label>
      ${areaNotas(d.notas)}`;
  } else if (aq.tipo === 'llave'){
    pestañas.datos = `${campo('Nombre o ubicación','nombre',d.nombre,'text','placeholder="Ej. Llave del sector norte"')}${areaNotas(d.notas)}`;
  } else if (aq.tipo === 'conector'){
    const rot = Math.round(num(d.rotacion)) % 360;
    pestañas.datos = `
      <label class="campo"><span>Forma</span></label>
      <div class="segmento" role="group" aria-label="Forma del conector">
        <button data-forma="T" class="${d.forma !== 'Y' ? 'on' : ''}">En T</button>
        <button data-forma="Y" class="${d.forma === 'Y' ? 'on' : ''}">En Y</button></div>
      <label class="campo"><span>Orientación: <output id="rotVal">${rot}°</output></span>
        <input type="range" id="rotRange" min="0" max="359" step="1" value="${rot}"></label>
      <div class="fila">
        <button class="btn chico" data-girar="-15">↺ 15°</button><button class="btn chico" data-girar="15">↻ 15°</button>
        <button class="btn chico" data-girar="180">Girar 180°</button>
        ${d.forma !== 'Y' ? '<button class="btn chico" id="conEspejo">Cambiar lado del brazo lateral</button>' : ''}</div>
      <label class="campo"><span>Tamaño de los brazos: <output id="tamVal">${Acu.tamanoConector(d).toFixed(1)} m</output></span>
        <input type="range" id="tamRange" min="0.5" max="6" step="0.5" value="${Acu.tamanoConector(d)}"></label>
      <p class="nota">Las tuberías unidas se estiran o acortan solas al cambiar el tamaño o el giro.</p>
      ${campo('Nombre (opcional)','nombre',d.nombre,'text','placeholder="Ej. Unión frente a la escuela"')}
      ${areaNotas(d.notas)}`;
  }
  if (tabs.includes('inc')) pestañas.inc = '<div id="incBox"></div>';

  const barraTabs = tabs.length > 1 ? `<div class="p-tabs" role="tablist">${tabs.map(t =>
    `<button role="tab" data-tab="${t}" aria-selected="${t === tabActivo[aq.tipo]}">${NOMBRE_TAB[t]}${t === 'inc' && nInc ? ` <span class="badge">${nInc}</span>` : ''}</button>`).join('')}</div>` : '';
  const cuerpoTabs = tabs.map(t => `<div class="p-tab" data-panel="${t}" ${t === tabActivo[aq.tipo] ? '' : 'hidden'}>${pestañas[t] || ''}</div>`).join('');

  /* --- Más opciones --- */
  const colorActual = aq.color || TIPOS[aq.tipo].color;
  const conColor = !['tuberia', 'conector', 'sin'].includes(aq.tipo);
  const mas = `<details class="p-mas"><summary>Más opciones</summary>
      ${aq.tipo !== 'sin' ? `<label class="campo"><span>Cambiar función</span></label>${botonesTipo(layer)}` : ''}
      ${conColor ? `<label class="campo"><span>Color</span></label>
        <div class="colores">${PALETA.map(c => `<button data-color="${c}" style="background:${c}" class="${c.toLowerCase() === colorActual.toLowerCase() ? 'on' : ''}" aria-label="Color ${c}"></button>`).join('')}
        <input type="color" id="colorLibre" value="${esc(colorActual)}" aria-label="Otro color"></div>
        ${aq.tipo === 'casa' && state.settings.colorPorPago ? '<p class="nota">El color de las casas lo decide el estado de pago (Configuración).</p>' : ''}
        ${aq.tipo === 'sector' ? '<p class="nota">Este color se ve cuando el sector tiene agua; sin agua se muestra gris.</p>' : ''}` : ''}
      <div class="fila" style="margin-top:12px"><button class="btn peligro" id="pEliminar">Eliminar forma</button></div>
    </details>`;

  const cuerpo = $('#pCuerpo');
  cuerpo.innerHTML = `<div class="p-barra">${acciones}</div>${estado}${barraTabs}${cuerpoTabs}${mas}`;
  enlazarPanel(layer, cuerpo);
}

function botonesTipo(layer){
  return `<div class="tipos" role="group" aria-label="Función de la forma">${['casa','tuberia','llave','sector','conector','sin'].map(t => {
    const bloqueado = (t === 'sector' && !esPoligono(layer)) || (t === 'conector' && !esPunto(layer)) || (t === 'tuberia' && !esLinea(layer));
    return `<button data-tipo="${t}" class="${layer.aq.tipo === t ? 'on' : ''}" ${bloqueado ? 'disabled' : ''}>${TIPOS[t].nombre}</button>`;
  }).join('')}</div>`;
}

function enlazarPanel(layer, cuerpo){
  const aq = layer.aq;
  cuerpo.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    tabActivo[aq.tipo] = b.dataset.tab;
    cuerpo.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    cuerpo.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.tab; });
  }));
  cuerpo.querySelectorAll('[data-k]').forEach(el => el.addEventListener('input', () => { aq.datos[el.dataset.k] = el.value; cambio(); }));
  cuerpo.querySelectorAll('[data-tipo]').forEach(b => b.addEventListener('click', () => cambiarTipo(b.dataset.tipo)));
  cuerpo.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => ponerColor(b.dataset.color)));
  if ($('#colorLibre')) $('#colorLibre').addEventListener('input', e => ponerColor(e.target.value, true));
  cuerpo.querySelectorAll('[data-estado]').forEach(b => b.addEventListener('click', () => {
    aq.datos.estado = b.dataset.estado;
    cuerpo.querySelectorAll('[data-estado]').forEach(x => x.classList.toggle('on', x === b));
    cambio(); actualizarTituloPanel();
  }));
  const rango = $('#opRange');
  if (rango) rango.addEventListener('input', () => { aq.datos.opacidad = Number(rango.value) / 100; $('#opVal').textContent = rango.value + '%'; cambio(); });
  const flujo = $('#secFlujo');
  if (flujo) flujo.addEventListener('change', () => ponerFlujo(layer, flujo.checked));
  cuerpo.querySelectorAll('[data-flujo]').forEach(b => b.addEventListener('click', () => {
    aq.datos.flujo = b.dataset.flujo;
    cuerpo.querySelectorAll('[data-flujo]').forEach(x => x.classList.toggle('on', x === b));
    guardarForma(aq.id); geometriaCambio();
    aviso(b.dataset.flujo ? 'Dirección del agua guardada.' : 'Dirección del agua sin definir.');
  }));
  cuerpo.querySelectorAll('[data-sector-tubo]').forEach(c => c.addEventListener('change', () => {
    aq.datos.sectores = [...cuerpo.querySelectorAll('[data-sector-tubo]:checked')].map(x => x.dataset.sectorTubo);
    guardarForma(aq.id); geometriaCambio();
  }));
  // Acciones rápidas
  $('#pCentrar').addEventListener('click', () => enfocar(layer));
  if ($('#pEditar')) $('#pEditar').addEventListener('click', () => alternarEdicion(layer));
  if ($('#pRamal')) $('#pRamal').addEventListener('click', () => iniciarTrazado('ramal', layer));
  if ($('#pCasaCasa')) $('#pCasaCasa').addEventListener('click', () => iniciarTrazado('casaCasa', layer, centroCasa(layer)));
  if ($('#verRed')) $('#verRed').addEventListener('click', () => resaltarRed(layer));
  if ($('#conectarCasa')) $('#conectarCasa').addEventListener('click', () => iniciarTrazado('acometida', layer));
  // Conector
  cuerpo.querySelectorAll('[data-forma]').forEach(b => b.addEventListener('click', () => cambiarConector(layer, {forma:b.dataset.forma})));
  cuerpo.querySelectorAll('[data-girar]').forEach(b => b.addEventListener('click', () =>
    cambiarConector(layer, {rotacion:(num(aq.datos.rotacion) + Number(b.dataset.girar) + 360) % 360})));
  const rot = $('#rotRange');
  if (rot){
    rot.addEventListener('input', () => { $('#rotVal').textContent = rot.value + '°'; cambiarConector(layer, {rotacion:Number(rot.value)}, true); });
    rot.addEventListener('change', () => cambiarConector(layer, {rotacion:Number(rot.value)}));
  }
  if ($('#conEspejo')) $('#conEspejo').addEventListener('click', () => cambiarConector(layer, {espejo:!aq.datos.espejo}));
  const tam = $('#tamRange');
  if (tam){
    tam.addEventListener('input', () => { $('#tamVal').textContent = Number(tam.value).toFixed(1) + ' m'; cambiarConector(layer, {tamano:Number(tam.value)}, true); });
    tam.addEventListener('change', () => cambiarConector(layer, {tamano:Number(tam.value)}));
  }
  cuerpo.querySelectorAll('[data-entrada]').forEach(b => b.addEventListener('click', () => {
    cambiarConector(layer, {entrada:Number(b.dataset.entrada)});
    aviso(`El agua entra por el brazo ${Number(b.dataset.entrada) + 1}; las tuberías unidas ya muestran la nueva dirección.`, 5000);
  }));
  if ($('#quitarEntrada')) $('#quitarEntrada').addEventListener('click', () => cambiarConector(layer, {entrada:null}));
  cuerpo.querySelectorAll('[data-desde-puerto]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.desdePuerto), pr = Acu.puertosConector(layer.getLatLng(), aq.datos);
    if (pr.entradaIdx === i) iniciarTrazado('entrada', layer, null);     // hacia la entrada: se termina en la punta
    else iniciarTrazado('salida', layer, pr.todos[i]);                   // desde el brazo: el trazo ya empieza ahí
  }));
  cuerpo.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', () => { const l = capas.get(b.dataset.ir); if (l){ enfocar(l); seleccionar(l); } }));
  $('#pEliminar').addEventListener('click', () => {
    if (!confirm('¿Eliminar esta forma? Se borra para todos, también del mapa público. Su historial de incidencias se conserva.')) return;
    eliminarForma(layer);
    aviso('Forma eliminada.');
  });
  marcarExtremos(layer);
  formIncAbierto = false;
  renderIncidenciasPanel();
  if (aq.tipo === 'casa'){ refrescarCuenta(); renderPagos(); $('#pgAgregar').addEventListener('click', () => registrarPago(layer)); }
}

/* =====================================================================
   MOVER PUNTOS DE UNA FORMA
   ===================================================================== */
let editando = null;
function alternarEdicion(layer){
  if (editando === layer){ terminarEdicion(); return; }
  terminarEdicion();
  asegurarMapa();
  editando = layer;
  if (esLinea(layer)) layer.pm._otherSnapLayers = puertosParaUnir();
  layer.pm.enable({snappable:true, snapDistance:18, allowSelfIntersection:true, draggable:esPunto(layer)});
  $('#pista').textContent = esPunto(layer)
    ? 'Arrastra el punto a su nuevo lugar. Pulsa «Listo» al terminar.'
    : 'Arrastra los puntos blancos. Toca un punto pequeño intermedio para agregar uno nuevo; clic derecho sobre un punto lo borra. Pulsa «Listo» al terminar.';
  $('#pista').hidden = false;
  if (selected === layer) renderPanel();
}
function terminarEdicion(){
  const layer = editando;
  if (!layer) return;
  editando = null;
  if (layer.pm && layer.pm.enabled()) layer.pm.disable();
  $('#pista').hidden = !pendingTipo;
  if (layer.aq && layer.aq.tipo === 'tuberia'){
    const msg = ajustarAConectores(layer);
    if (msg) aviso(msg, 5000);
  }
  if (layer.aq){ guardarForma(layer.aq.id); geometriaCambio(); }
  if (selected === layer) renderPanel();
}

async function registrarPago(layer){
  const aq = layer.aq;
  const monto = Math.round(num($('#pgMonto').value) * 100) / 100;
  const fecha = $('#pgFecha').value || hoyISO();
  if (monto <= 0){ aviso('Escribe un monto mayor que cero.'); $('#pgMonto').focus(); return; }
  const btn = $('#pgAgregar'); btn.disabled = true;
  const pago = {id:uid(), fecha, monto, nota:$('#pgNota').value.trim()};
  await flush();
  const ok = await tarea(sb.from('pagos').insert({id:pago.id, forma_id:aq.id, fecha, monto, nota:pago.nota}), 'No se pudo registrar el pago');
  if (ok){
    aq.datos.pagos = aq.datos.pagos || [];
    if (!aq.datos.pagos.some(p => p.id === pago.id)) aq.datos.pagos.push(pago);
    refrescarForma(layer);
    if (selected === layer){ $('#pgNota').value = ''; $('#pgMonto').value = ''; renderPagos(); }
    aviso('Pago registrado: ' + dinero(monto));
  }
  if (btn.isConnected) btn.disabled = false;
}

function actualizarTituloPanel(){
  if (!selected) return;
  const aq = selected.aq;
  let sub = TIPOS[aq.tipo].nombre;
  if (aq.tipo === 'casa') sub = textoEstado(cuenta(aq)).txt;
  if (aq.tipo === 'sector') sub = aq.datos.activo ? 'Sector con agua' : 'Sector sin agua';
  const inc = textoIncidencias(aq.id);
  if (inc) sub = '⚠ Incidencia: ' + inc;
  $('#pTitulo').innerHTML = `${esc(titulo(aq))}<small${inc ? ` style="color:${ROJO};font-weight:700"` : ''}>${esc(sub)}</small>`;
}

function refrescarCuenta(){
  const box = $('#cuentaBox'); if (!box || !selected) return;
  const aq = selected.aq, c = cuenta(aq), est = textoEstado(c);
  const auto = Math.max(0, num(aq.datos.nucleos)) * num(state.settings.cuota);
  const inEsp = $('#inCuotaEsp'); if (inEsp) inEsp.placeholder = 'Automática: ' + dinero(auto);
  box.innerHTML = `
    <div class="estado"><span>Estado de cuenta</span><span class="pill ${est.cls}">${esc(est.txt)}</span></div>
    ${c.aplica ? `<dl>
      <dt>Cuota mensual${c.especial ? ' (especial)' : ''}</dt><dd>${dinero(c.cuotaMes)}</dd>
      <dt>Meses cobrados</dt><dd>${c.meses}</dd>
      <dt>Total a pagar</dt><dd>${dinero(c.esperado)}</dd>
      <dt>Pagado</dt><dd>${dinero(c.pagado)}</dd>
      <dt>Saldo</dt><dd class="total">${dinero(c.saldo)}</dd>
      ${c.atraso ? `<dt>Cuotas atrasadas</dt><dd class="total">${c.atraso}</dd>` : ''}
    </dl>` : '<p class="nota" style="margin:0">Indica desde qué mes se cobra para calcular lo que debe.</p>'}`;
  const pm = $('#pgMonto'); if (pm && c.cuotaMes) pm.placeholder = c.cuotaMes.toFixed(2);
}

function renderPagos(){
  const ul = $('#listaPagos'); if (!ul || !selected) return;
  const layer = selected;
  const pagos = [...(layer.aq.datos.pagos || [])].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  if (!pagos.length){ ul.innerHTML = '<li class="nota">Todavía no hay pagos registrados.</li>'; return; }
  ul.innerHTML = pagos.map(p => `<li><span>${esc(p.fecha)}${p.nota ? '<br><small class="nota">' + esc(p.nota) + '</small>' : ''}</span>
    <span><b>${dinero(p.monto)}</b> <button class="x" data-borrar="${esc(p.id)}" aria-label="Borrar pago">×</button></span></li>`).join('');
  ul.querySelectorAll('[data-borrar]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('¿Borrar este pago?')) return;
    const id = b.dataset.borrar;
    const ok = await tarea(sb.from('pagos').delete().eq('id', id), 'No se pudo borrar el pago');
    if (!ok) return;
    layer.aq.datos.pagos = layer.aq.datos.pagos.filter(p => p.id !== id);
    refrescarForma(layer);
    if (selected === layer) renderPagos();
  }));
}

function cambio(){
  if (!selected) return;
  refrescarForma(selected);
  guardarForma(selected.aq.id);
}

async function cambiarTipo(nuevo){
  const layer = selected, aq = layer.aq;
  if (nuevo === aq.tipo) return;
  if (nuevo === 'sector' && !esPoligono(layer)){ aviso('Un sector debe ser un área cerrada.'); return; }
  if (nuevo === 'conector' && !esPunto(layer)){ aviso('Un conector es un punto: dibújalo con «Conector en T» o «en Y».'); return; }
  const tienePagos = aq.tipo === 'casa' && (aq.datos.pagos || []).length;
  if (tienePagos && !confirm('Esta casa tiene pagos registrados. Si cambias su función se borrarán. ¿Continuar?')) return;
  if (tienePagos){
    const ok = await tarea(sb.from('pagos').delete().eq('forma_id', aq.id), 'No se pudieron borrar los pagos');
    if (!ok) return;
  }
  const base = datosBase(nuevo);
  Object.keys(base).forEach(k => { if (k in aq.datos && k !== 'pagos') base[k] = aq.datos[k]; });
  aq.tipo = nuevo;
  aq.datos = base;
  if (!aq.colorManual) aq.color = TIPOS[nuevo].color;
  geometriaCambio();
  aplicarEstilo(layer); actualizarTooltip(layer);
  if (nuevo !== 'sector' && layer._map) layer.bringToFront();
  guardarForma(aq.id); renderResumen();
  if (selected === layer) renderPanel();
}

function ponerColor(c, desdeSelector){
  const aq = selected.aq;
  aq.color = c; aq.colorManual = true;
  aplicarEstilo(selected);
  document.querySelectorAll('#pCuerpo [data-color]').forEach(b => b.classList.toggle('on', b.dataset.color.toLowerCase() === c.toLowerCase()));
  if (!desdeSelector) $('#colorLibre').value = c;
  guardarForma(aq.id);
  renderResumenPronto();
}

/* =====================================================================
   SECCIONES Y NAVEGACIÓN
   Cada sección es una "vista" dentro de la misma página. La dirección
   (#/inicio, #/mapa, #/casas…) indica cuál se muestra, así funcionan
   los botones Atrás/Adelante del navegador y se pueden guardar enlaces.
   ===================================================================== */
let vistaActual = null, mapaAjustado = false, casasFiltradas = [];
const RENDER = {
  'inicio': renderInicio,
  'resumen': renderResumenVista,
  'incidencias/abiertas': renderIncAbiertas,
  'incidencias/resueltas': renderIncResueltas,
  'incidencias/calendario': renderCalendario,
  'incidencias/reportes': renderReportes,
  'usuarios/solicitudes': renderSolicitudes,
  'usuarios/vecinos': renderVecinos,
  'usuarios/administradores': renderAdministradores,
  'sectores': renderSectoresVista,
  'casas': renderCasasVista
};
const GRUPO_DE = {'inicio':'inicio', 'resumen':'inicio', 'mapa':'mapa', 'incidencias/abiertas':'incidencias',
  'incidencias/resueltas':'incidencias', 'incidencias/calendario':'incidencias', 'incidencias/reportes':'incidencias', 'usuarios/solicitudes':'usuarios', 'usuarios/vecinos':'usuarios', 'usuarios/administradores':'usuarios', 'sectores':'gestion', 'casas':'gestion', 'configuracion':'config'};

function router(){
  const ruta = location.hash.replace(/^#\/?/, '') || 'inicio';
  let base = ruta, extra = null;
  if (ruta.startsWith('mapa/dibujar/')){ base = 'mapa'; extra = ruta.split('/')[2]; }
  else if (ruta.startsWith('configuracion/')){ base = 'configuracion'; extra = ruta.split('/')[1]; }
  if (!(base in GRUPO_DE)) base = 'inicio';
  mostrarVista(base);
  if (base === 'mapa' && extra && PISTAS[extra] && extra !== 'acometida'){
    history.replaceState(null, '', '#/mapa');
    if (pendingTipo !== extra) iniciarDibujo(extra);
  }
  if (base === 'configuracion' && extra){
    const el = document.getElementById('cfg-' + extra);
    if (el) setTimeout(() => el.scrollIntoView({behavior:'smooth', block:'start'}), 30);
  }
}
window.addEventListener('hashchange', () => { if (appIniciada) router(); });

function mostrarVista(v){
  if (v !== 'mapa') salirHistorico();
  const cambio = vistaActual !== v;
  vistaActual = v;
  if (cambio){
    document.querySelectorAll('[data-vista]').forEach(s => { s.hidden = s.dataset.vista !== v; });
    marcarNav();
    if (v === 'mapa'){ map.invalidateSize(); ajustarMapaInicial(); }
    else {
      if (pendingTipo){ map.pm.disableDraw(); pendingTipo = null; marcarBotones(); }
      terminarModoPunto(false);
      if (selected) cerrarPanel();
    }
    $('#vistas').scrollTop = 0;
  }
  cerrarMenus(); cerrarNavMovil();
  renderVistaActual();
}
function renderVistaActual(){ const f = RENDER[vistaActual]; if (f) f(); }
function asegurarMapa(){
  if (vistaActual === 'mapa') return;
  if (location.hash !== '#/mapa') history.pushState(null, '', '#/mapa');
  mostrarVista('mapa');
}
function ajustarMapaInicial(){
  if (mapaAjustado) return;
  mapaAjustado = true;
  let guardada = null; try { guardada = localStorage.getItem(VISTA_KEY); } catch (e){}
  if (!guardada) enfocarTodo();
}
function enfocarTodo(){ if (capa.getLayers().length) map.fitBounds(capa.getBounds(), {maxZoom:19, padding:[40,40]}); }

function marcarNav(){
  const grupo = GRUPO_DE[vistaActual];
  document.querySelectorAll('.grupo[data-grupo]').forEach(g => g.classList.toggle('activo', g.dataset.grupo === grupo));
  document.querySelectorAll('.submenu a[data-ruta]').forEach(a => {
    if (a.dataset.ruta === vistaActual) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

/* --- Menús desplegables --- */
function cerrarMenus(excepto){
  document.querySelectorAll('.grupo.abierto').forEach(g => {
    if (g === excepto) return;
    g.classList.remove('abierto');
    const b = g.querySelector(':scope > .nav-btn'); if (b) b.setAttribute('aria-expanded', 'false');
  });
}
function cerrarNavMovil(){ $('#nav').classList.remove('abierto'); $('#menuBtn').setAttribute('aria-expanded', 'false'); }
function cerrarLateralMovil(){ cerrarMenus(); cerrarNavMovil(); }
document.querySelectorAll('.grupo > .nav-btn').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation();
  const g = b.parentElement, abrir = !g.classList.contains('abierto');
  cerrarMenus(g);
  g.classList.toggle('abierto', abrir);
  b.setAttribute('aria-expanded', String(abrir));
}));
document.addEventListener('click', e => { if (!e.target.closest('.grupo') && !e.target.closest('#menuBtn')) cerrarMenus(); });
document.querySelectorAll('.submenu a').forEach(a => a.addEventListener('click', () => {
  const href = a.getAttribute('href');
  cerrarMenus(); cerrarNavMovil();
  if (href && href === location.hash) setTimeout(router, 0);   // misma dirección: volver a aplicar
}));
$('#menuBtn').addEventListener('click', e => {
  e.stopPropagation();
  const abierto = $('#nav').classList.toggle('abierto');
  $('#menuBtn').setAttribute('aria-expanded', String(abierto));
});
document.addEventListener('keydown', e => { if (e.key === 'Escape'){ cerrarMenus(); cerrarNavMovil(); } });

/* --- Enlaces a elementos del mapa --- */
function verForma(id){
  const l = capas.get(id);
  if (!l){ aviso('Ese elemento ya no existe.'); return; }
  asegurarMapa(); enfocar(l); seleccionar(l);
}
/* =====================================================================
   MODO HISTORIAL: el mapa muestra solo una incidencia pasada y lo que afectó
   ===================================================================== */
let historico = null;
function verHistorico(inc){
  if (!inc) return;
  const o = capas.get(inc.forma_id);
  if (!o){ aviso('El elemento de esta incidencia ya no existe en el mapa.'); return; }
  cerrarPanel();
  if (pendingTipo){ map.pm.disableDraw(); pendingTipo = null; trazado = null; marcarBotones(); }
  historico = inc;
  location.hash = '#/mapa';
  asegurarMapa();
  map.getContainer().classList.add('modo-historial');
  recalcularIncidencias();
  const r = afectacionDe(inc), b = L.latLngBounds([]);
  [...r.formas, ...r.tubos, inc.forma_id].forEach(id => { const l = capas.get(id); if (l) b.extend(l.getBounds ? l.getBounds() : l.getLatLng()); });
  r.puntos.forEach(p => b.extend(p));
  if (b.isValid()) setTimeout(() => map.fitBounds(b, {maxZoom:19, padding:[70,70]}), 50);
  const abierta = inc.estado === 'abierta';
  const banner = $('#bannerHist');
  banner.innerHTML = `<div class="bh-cab"><span class="bh-etq">📅 Historial</span><b>${esc(inc.tipo)}</b>
      <span class="pill ${abierta ? 'bad' : 'ok'}">${abierta ? 'Sigue abierta' : 'Resuelta'}</span></div>
    <p><b>${esc(titulo(o.aq))}</b></p>
    <p>Ocurrió: <b>${esc(Acu.fechaHora(inc.creada_en))}</b>${inc.resuelta_en ? ` · Resuelta: <b>${esc(Acu.fechaHora(inc.resuelta_en))}</b> · duró ${esc(duracion(inc.creada_en, inc.resuelta_en))}` : ''}</p>
    <p>Sin agua o afectado: ${esc(Acu.textoAfectacion(r))}</p>
    ${inc.detalle ? `<p class="bh-det">${esc(inc.detalle)}</p>` : ''}
    ${textoControl(inc)}
    <p class="bh-nota">Se dibuja sobre la red actual de tuberías.</p>
    <button class="btn primario chico" id="salirHist">Volver al mapa en vivo</button>`;
  banner.hidden = false;
  $('#salirHist').addEventListener('click', salirHistorico);
}
function salirHistorico(){
  if (!historico) return;
  historico = null;
  $('#bannerHist').hidden = true;
  map.getContainer().classList.remove('modo-historial');
  recalcularIncidencias();
}
function verIncidencia(inc, comoHistorial){
  if (!inc) return;
  if (comoHistorial || inc.estado === 'resuelta'){ verHistorico(inc); return; }
  salirHistorico();
  const o = capas.get(inc.forma_id);
  if (!o){ aviso('El elemento de esta incidencia ya no existe.'); return; }
  asegurarMapa();
  const r = inc.estado === 'abierta' ? afectacionDe(inc) : Acu.afectacion(redActual(), inc, origenDe(inc));
  const b = L.latLngBounds([]);
  [...r.formas, ...r.tubos, inc.forma_id].forEach(id => { const l = capas.get(id); if (l) b.extend(l.getBounds ? l.getBounds() : l.getLatLng()); });
  r.puntos.forEach(p => b.extend(p));
  if (b.isValid()) map.fitBounds(b, {maxZoom:19, padding:[60,60]});
  seleccionar(o);
}
function enlazar(cont){
  cont.querySelectorAll('[data-ver]').forEach(b => b.addEventListener('click', () => verForma(b.dataset.ver)));
  cont.querySelectorAll('[data-ver-inc]').forEach(b => b.addEventListener('click', () => verIncidencia(incidencias.get(b.dataset.verInc), b.dataset.hist === '1')));
  cont.querySelectorAll('[data-flujo-id]').forEach(c => c.addEventListener('change', () => {
    const l = capas.get(c.dataset.flujoId); if (l) ponerFlujo(l, c.checked);
  }));
  cont.querySelectorAll('[data-resolver-id]').forEach(b => b.addEventListener('click', () => pedirResolucion(b.dataset.resolverId)));
  cont.querySelectorAll('[data-reabrir-id]').forEach(b => b.addEventListener('click', () => {
    if (confirm('¿Reabrir esta incidencia? Volverá a marcarse en rojo en el mapa.'))
      actualizarIncidencia(b.dataset.reabrirId, {estado:'abierta', resuelta_en:null, atendida_por:null, nota_cierre:null}, 'Incidencia reabierta.');
  }));
  cont.querySelectorAll('[data-borrar-inc-id]').forEach(b => b.addEventListener('click', () => {
    const dlg = $('#dlgDia'); if (dlg.open) dlg.close();
    if (confirm('¿Eliminar esta incidencia del historial? No se puede deshacer.')) borrarIncidencia(b.dataset.borrarIncId);
  }));
}

/* --- Datos comunes para las secciones --- */
function datosGenerales(){
  const casas = [], tubos = [], llaves = [], sectores = [];
  const grupos = {casa:casas, tuberia:tubos, llave:llaves, sector:sectores};
  capa.eachLayer(l => { if (l.aq && grupos[l.aq.tipo]) grupos[l.aq.tipo].push(l); });
  return {casas, tubos, llaves, sectores};
}
const estaConectada = id => ((redActual().casaNodos.get(id)) || new Set()).size > 0;
function nombreSectorDe(l){
  const ids = sectoresDe(l);
  const s = ids.length && capas.get(ids[0]);
  return s ? (s.aq.datos.nombre || 'Sin nombre') : '';
}
const incAbiertas = () => [...incidencias.values()].filter(i => i.estado === 'abierta')
  .sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en)));
const capitalizar = s => s.charAt(0).toUpperCase() + s.slice(1);
const nombreCasa = d => d.numero ? 'Casa ' + d.numero : 'Casa sin número';
function duracion(a, b){
  const min = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return h + ' h' + (m ? ' ' + m + ' min' : '');
  const d = Math.floor(h / 24);
  return d + (d === 1 ? ' día' : ' días') + (h % 24 ? ' ' + (h % 24) + ' h' : '');
}
function descargar(contenido, nombre, tipo){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contenido], {type:tipo}));
  a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function actualizarBadges(){
  const n = [...incidencias.values()].filter(i => i.estado === 'abierta').length;
  document.querySelectorAll('[data-badge-inc]').forEach(b => { b.textContent = n; b.hidden = !n; });
  const nSol = solicitudes.filter(x => x.estado === 'pendiente').length, nRep = reportesLista.filter(x => x.estado === 'nuevo').length;
  document.querySelectorAll('[data-badge-sol]').forEach(b => { b.textContent = nSol; b.hidden = !nSol; });
  document.querySelectorAll('[data-badge-rep]').forEach(b => { b.textContent = nRep; b.hidden = !nRep; });
  $('#nombreAcu').textContent = state.settings.nombre || 'Mi acueducto';
  document.title = 'Administración: ' + (state.settings.nombre || 'acueducto');
}
function renderResumen(){ actualizarBadges(); renderVistaActual(); }
const renderResumenPronto = debounce(renderResumen, 250);

/* --- Piezas reutilizables --- */
const kpi = (href, valor, etiqueta, detalle, cls = '') =>
  `<a class="kpi ${cls}" href="${href}"><span class="kpi-etq">${etiqueta}</span><b>${valor}</b><small>${detalle}</small></a>`;

function filaSector(l){
  const d = l.aq.datos, inc = textoIncidencias(l.aq.id);
  const muestra = inc ? ROJO : d.activo ? (l.aq.color || TIPOS.sector.color) : Acu.SIN_FLUJO.relleno;
  const det = inc ? '⚠ ' + inc : (d.activo ? 'Con agua' : 'Sin agua') + (d.activoDesde ? ' ' + Acu.desde(d.activoDesde) : '');
  return `<li class="fila-sector"><button class="item" data-ver="${esc(l.aq.id)}"><i class="muestra" style="background:${esc(muestra)}"></i>
      <span>${esc(d.nombre || 'Sector sin nombre')}<small>${esc(det)}</small></span></button>
    <label class="interruptor" title="Flujo de agua"><input type="checkbox" data-flujo-id="${esc(l.aq.id)}" ${d.activo ? 'checked' : ''} aria-label="Agua en ${esc(d.nombre || 'sector')}"><span class="riel"></span></label></li>`;
}

function tarjetaIncidencia(inc){
  const o = capas.get(inc.forma_id), abierta = inc.estado === 'abierta';
  return `<div class="inc ${abierta ? '' : 'resuelta'}">
    <div class="inc-cab">${esDev() ? `<input type="checkbox" class="sel-inc" data-sel-inc="${esc(inc.id)}" aria-label="Seleccionar para borrar">` : ''}<b>${abierta ? '⚠' : '✓'} ${esc(inc.tipo)}</b>
      <span class="meta">${esc(abierta ? Acu.hace(inc.creada_en) : 'Resuelta en ' + duracion(inc.creada_en, inc.resuelta_en || inc.creada_en))}</span></div>
    <p class="meta"><b class="lugar">${esc(o ? titulo(o.aq) : 'Elemento eliminado')}</b> · Creada: ${esc(Acu.fechaHora(inc.creada_en))}${inc.resuelta_en ? ' · Resuelta: ' + esc(Acu.fechaHora(inc.resuelta_en)) : ''}</p>
    ${inc.detalle ? `<p>${esc(inc.detalle)}</p>` : ''}
    ${textoControl(inc)}
    ${abierta ? `<p class="meta">Marca en rojo: ${esc(textoAlcance(inc))}</p>` : ''}
    <div class="acciones">
      ${o ? `<button class="btn chico" data-ver-inc="${esc(inc.id)}">Ver en el mapa</button>` : ''}
      ${abierta
        ? `<button class="btn chico primario" data-resolver-id="${esc(inc.id)}">Marcar resuelta</button>`
        : `<button class="btn chico" data-reabrir-id="${esc(inc.id)}">Reabrir</button>`}
      ${esDev() ? `<button class="btn chico peligro" data-borrar-inc-id="${esc(inc.id)}" title="Solo el desarrollador">Eliminar</button>` : ''}
    </div></div>`;
}

/* ================= Sección: Dashboard ================= */
function renderInicio(){
  const {casas, sectores} = datosGenerales();
  const mes = hoyISO().slice(0, 7);
  let total = 0, sinCon = 0, cobradoMes = 0;
  const conDeuda = [], pagos = [];
  casas.forEach(l => {
    const c = cuenta(l.aq);
    if (c.saldo > 0){ total += c.saldo; conDeuda.push({l, c}); }
    if (!estaConectada(l.aq.id)) sinCon++;
    (l.aq.datos.pagos || []).forEach(p => { pagos.push({l, p}); if (String(p.fecha).startsWith(mes)) cobradoMes += num(p.monto); });
  });
  conDeuda.sort((a, b) => b.c.saldo - a.c.saldo);
  pagos.sort((a, b) => String(b.p.fecha).localeCompare(String(a.p.fecha)));
  const abiertas = incAbiertas();
  const conAgua = sectores.filter(s => s.aq.datos.activo).length;
  const hoy = capitalizar(new Date().toLocaleDateString('es', {weekday:'long', day:'numeric', month:'long', year:'numeric'}));
  sectores.sort((a, b) => String(a.aq.datos.nombre).localeCompare(String(b.aq.datos.nombre), 'es', {numeric:true}));

  const cont = $('#dash');
  cont.innerHTML = `
    <div class="cab-vista">
      <div><h1>${esc(state.settings.nombre || 'Mi acueducto')}</h1><p>${esc(hoy)}</p></div>
      <div class="fila"><a class="btn" href="#/mapa">Abrir mapa</a><a class="btn primario" href="#/incidencias/abiertas">Ver incidencias</a></div>
    </div>
    <div class="kpis">
      ${kpi('#/incidencias/abiertas', abiertas.length, 'Incidencias abiertas',
          abiertas.length ? 'La más reciente ' + esc(Acu.hace(abiertas[0].creada_en)) : 'Todo en orden', abiertas.length ? 'alerta' : 'ok')}
      ${kpi('#/sectores', `${conAgua} <span>de ${sectores.length}</span>`, 'Sectores con agua',
          sectores.length ? (conAgua === sectores.length ? 'Todos con servicio' : `${sectores.length - conAgua} sin agua`) : 'Aún no hay sectores')}
      ${kpi('#/casas', casas.length, 'Casas', sinCon ? `${sinCon} sin conexión a tubería` : (casas.length ? 'Todas conectadas' : 'Aún no hay casas'), sinCon ? 'aviso' : '')}
      ${kpi('#/casas', esc(dinero(total)), 'Por cobrar', `${conDeuda.length} ${conDeuda.length === 1 ? 'casa' : 'casas'} con deuda`, total > 0 ? 'deuda' : '')}
      ${kpi('#/resumen', esc(dinero(cobradoMes)), 'Cobrado este mes', 'Ver el resumen de cobros')}
    </div>
    <div class="rejilla">
      <article class="tarjeta">
        <header><h2>Incidencias abiertas</h2><a href="#/incidencias/abiertas">Ver todas</a></header>
        ${abiertas.length ? abiertas.slice(0, 4).map(tarjetaIncidencia).join('') : '<p class="vacio">✓ No hay incidencias abiertas.</p>'}
      </article>
      <article class="tarjeta">
        <header><h2>Flujo de agua por sector</h2><a href="#/sectores">Administrar</a></header>
        ${sectores.length ? `<ul class="lista">${sectores.map(filaSector).join('')}</ul>` : '<p class="vacio">Aún no hay sectores. <a href="#/mapa/dibujar/sector">Dibujar un sector</a></p>'}
      </article>
      <article class="tarjeta">
        <header><h2>Casas con más deuda</h2><a href="#/casas">Ver casas</a></header>
        ${conDeuda.length ? `<ul class="lista">${conDeuda.slice(0, 6).map(({l, c}) => {
            const est = textoEstado(c);
            return `<li><button class="item" data-ver="${esc(l.aq.id)}"><span>${esc(nombreCasa(l.aq.datos))}<small>${esc(l.aq.datos.responsable || 'Sin responsable')}</small></span><span class="pill ${est.cls}">${esc(est.txt)}</span></button></li>`;
          }).join('')}</ul>` : '<p class="vacio">✓ Ninguna casa tiene deuda.</p>'}
      </article>
      <article class="tarjeta">
        <header><h2>Últimos pagos</h2><a href="#/resumen">Resumen</a></header>
        ${pagos.length ? `<ul class="lista">${pagos.slice(0, 6).map(({l, p}) =>
            `<li><button class="item" data-ver="${esc(l.aq.id)}"><span>${esc(nombreCasa(l.aq.datos))}<small>${esc(p.fecha)}${p.nota ? ' · ' + esc(p.nota) : ''}</small></span><b class="monto">${esc(dinero(p.monto))}</b></button></li>`).join('')}</ul>`
          : '<p class="vacio">Todavía no hay pagos registrados.</p>'}
      </article>
      <article class="tarjeta ancha">
        <header><h2>Accesos rápidos</h2></header>
        <div class="accesos">
          <a class="acceso" href="#/mapa/dibujar/casa">＋ Dibujar casa</a>
          <a class="acceso" href="#/mapa/dibujar/tuberia">＋ Dibujar tubería</a>
          <a class="acceso" href="#/mapa/dibujar/llave">＋ Marcar llave</a>
          <a class="acceso" href="#/mapa/dibujar/sector">＋ Dibujar sector</a>
          <a class="acceso" href="#/casas">Buscar una casa</a>
          <a class="acceso" href="../../../index.html" target="_blank" rel="noopener">Ver mapa público ↗</a>
        </div>
      </article>
    </div>`;
  enlazar(cont);
}

/* ================= Sección: Resumen ================= */
function renderResumenVista(){
  const {casas, tubos, llaves, sectores} = datosGenerales();
  let principales = 0, acometidas = 0, metros = 0;
  tubos.forEach(l => { if (l.aq.datos.clase === 'acometida') acometidas++; else principales++; metros += longitud(l); });
  const cerradas = llaves.filter(l => l.aq.datos.estado === 'cerrada').length;
  const conAgua = sectores.filter(s => s.aq.datos.activo).length;

  const ahora = new Date(), mes = hoyISO().slice(0, 7);
  const meses = [];
  for (let i = 5; i >= 0; i--){
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const porMes = Object.fromEntries(meses.map(m => [m, 0]));
  let nucleos = 0, personas = 0, sinCon = 0, esperado = 0, porCobrar = 0, deben = 0, alDia = 0, adelantadas = 0, cobradoMes = 0, cobradoTotal = 0;
  casas.forEach(l => {
    const d = l.aq.datos, c = cuenta(l.aq);
    nucleos += num(d.nucleos); personas += num(d.personas);
    if (!estaConectada(l.aq.id)) sinCon++;
    if (c.aplica){
      esperado += c.cuotaMes;
      if (c.saldo > 0){ deben++; porCobrar += c.saldo; } else if (c.saldo < 0) adelantadas++; else alDia++;
    }
    (d.pagos || []).forEach(p => {
      const k = String(p.fecha).slice(0, 7), m = num(p.monto);
      cobradoTotal += m;
      if (k === mes) cobradoMes += m;
      if (k in porMes) porMes[k] += m;
    });
  });

  const todas = [...incidencias.values()];
  const abiertas = todas.filter(i => i.estado === 'abierta').length;
  const resueltas = todas.filter(i => i.estado === 'resuelta' && i.resuelta_en);
  const resueltasMes = resueltas.filter(i => { const d = new Date(i.resuelta_en); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === mes; }).length;
  const promedio = resueltas.length
    ? duracion(0, resueltas.reduce((s, i) => s + (new Date(i.resuelta_en) - new Date(i.creada_en)), 0) / resueltas.length) : '—';
  const porTipo = {};
  todas.forEach(i => { porTipo[i.tipo] = (porTipo[i.tipo] || 0) + 1; });
  const tiposOrden = Object.entries(porTipo).sort((a, b) => b[1] - a[1]);
  const maxTipo = Math.max(1, ...tiposOrden.map(t => t[1]));
  const maxMes = Math.max(1, ...Object.values(porMes));
  const stat = (v, l, cls = '') => `<div class="stat ${cls}"><b>${v}</b><span>${l}</span></div>`;
  const km = m => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';

  const cont = $('#resumenCont');
  cont.innerHTML = `
    <div class="rejilla">
      <section class="tarjeta">
        <header><h2>Red de agua</h2><a href="#/mapa">Ver mapa</a></header>
        <div class="stats">
          ${stat(principales, 'Tramos de línea principal')}${stat(acometidas, 'Acometidas a casas')}
          ${stat(km(metros), 'Largo total de tubería')}${stat(llaves.length, `Llaves (${cerradas} cerradas)`)}
          ${stat(`${conAgua} / ${sectores.length}`, 'Sectores con agua')}${stat(abiertas, 'Incidencias abiertas', abiertas ? 'rojo' : '')}
        </div>
      </section>
      <section class="tarjeta">
        <header><h2>Casas</h2><a href="#/casas">Ver casas</a></header>
        <div class="stats">
          ${stat(casas.length, 'Casas')}${stat(nucleos, 'Núcleos familiares')}
          ${stat(personas || '—', 'Personas')}${stat(casas.length - sinCon, 'Conectadas a la red')}
          ${stat(sinCon, 'Sin conexión', sinCon ? 'naranja' : '')}${stat(esc(dinero(state.settings.cuota)), 'Cuota por núcleo')}
        </div>
      </section>
      <section class="tarjeta">
        <header><h2>Cobros</h2></header>
        <div class="stats">
          ${stat(esc(dinero(esperado)), 'Cuota mensual esperada')}${stat(esc(dinero(cobradoMes)), 'Cobrado este mes')}
          ${stat(esc(dinero(porCobrar)), 'Por cobrar', porCobrar ? 'rojo' : '')}${stat(deben, 'Casas con deuda')}
          ${stat(alDia, 'Casas al día')}${stat(adelantadas, 'Casas adelantadas')}
        </div>
        <p class="nota">Cobrado en total: <b>${esc(dinero(cobradoTotal))}</b></p>
      </section>
      <section class="tarjeta">
        <header><h2>Cobrado por mes</h2></header>
        <div class="barras" role="img" aria-label="Cobrado en los últimos seis meses">
          ${meses.map(m => {
            const [y, mm] = m.split('-').map(Number);
            const etq = new Date(y, mm - 1, 1).toLocaleDateString('es', {month:'short'});
            return `<div class="barra-mes"><span class="valor">${esc(num(porMes[m]).toFixed(0))}</span><i style="height:${Math.round(porMes[m] / maxMes * 100)}%"></i><small>${esc(etq)}</small></div>`;
          }).join('')}
        </div>
        <p class="nota">Montos en ${esc(state.settings.moneda || '')}, según la fecha de cada pago.</p>
      </section>
      <section class="tarjeta">
        <header><h2>Incidencias</h2><a href="#/incidencias/resueltas">Historial</a></header>
        <div class="stats">
          ${stat(abiertas, 'Abiertas', abiertas ? 'rojo' : '')}${stat(resueltasMes, 'Resueltas este mes')}
          ${stat(esc(promedio), 'Tiempo medio de solución')}${stat(todas.length, 'Registradas en total')}
        </div>
      </section>
      <section class="tarjeta">
        <header><h2>Incidencias por tipo</h2></header>
        ${tiposOrden.length ? `<ul class="barras-h">${tiposOrden.map(([t, n]) =>
          `<li><span>${esc(t)}</span><i style="width:${Math.round(n / maxTipo * 100)}%"></i><b>${n}</b></li>`).join('')}</ul>`
          : '<p class="vacio">Todavía no hay incidencias registradas.</p>'}
      </section>
    </div>`;
}

/* ================= Secciones: Incidencias ================= */
function llenarFiltroTipos(sel, lista){
  const actual = sel.value;
  const nombres = [...new Set([...tiposInc.map(t => t.nombre), ...lista.map(i => i.tipo)])].sort((a, b) => a.localeCompare(b, 'es'));
  sel.innerHTML = '<option value="">Todos los tipos</option>' + nombres.map(n => `<option ${n === actual ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function filtrarInc(lista, busca, tipo){
  const q = busca.trim().toLowerCase();
  return lista.filter(i => (!tipo || i.tipo === tipo) && (!q ||
    [i.tipo, i.detalle, capas.get(i.forma_id) ? titulo(capas.get(i.forma_id).aq) : ''].join(' ').toLowerCase().includes(q)));
}
/* Limpieza de pruebas: solo el desarrollador puede elegir varias y borrarlas */
function barraLimpieza(cont, lista){
  if (!esDev() || !lista.length) return;
  const barra = document.createElement('div');
  barra.className = 'limpieza';
  barra.innerHTML = `<span><b>🧪 Limpieza de pruebas</b> <small>(solo desarrollador)</small></span>
    <label class="check"><input type="checkbox" data-sel-todas><span>Seleccionar las ${lista.length} visibles</span></label>
    <button class="btn chico peligro" data-borrar-sel disabled>Eliminar seleccionadas</button>`;
  cont.prepend(barra);
  const casillas = () => [...cont.querySelectorAll('[data-sel-inc]')];
  const actualizar = () => {
    const n = casillas().filter(c => c.checked).length, b = barra.querySelector('[data-borrar-sel]');
    b.disabled = !n; b.textContent = n ? `Eliminar seleccionadas (${n})` : 'Eliminar seleccionadas';
  };
  barra.querySelector('[data-sel-todas]').addEventListener('change', e => { casillas().forEach(c => { c.checked = e.target.checked; }); actualizar(); });
  casillas().forEach(c => c.addEventListener('change', actualizar));
  barra.querySelector('[data-borrar-sel]').addEventListener('click', () => {
    const ids = casillas().filter(c => c.checked).map(c => c.dataset.selInc);
    if (ids.length && confirm(`¿Eliminar ${ids.length} ${ids.length === 1 ? 'incidencia' : 'incidencias'} del historial? No se puede deshacer.`)) borrarIncidencias(ids);
  });
}
function renderIncAbiertas(){
  const todas = incAbiertas();
  llenarFiltroTipos($('#iaTipo'), todas);
  const lista = filtrarInc(todas, $('#iaBusca').value, $('#iaTipo').value);
  $('#iaConteo').textContent = todas.length ? `${lista.length} de ${todas.length}` : '';
  const cont = $('#iaLista');
  cont.innerHTML = lista.length ? lista.map(tarjetaIncidencia).join('')
    : `<div class="vacio-grande">${todas.length ? 'Ninguna incidencia coincide con el filtro.'
        : '✓ No hay incidencias abiertas.<br><small>Para reportar una, abre una casa, tubería o sector en el <a href="#/mapa">mapa</a>.</small>'}</div>`;
  enlazar(cont);
  barraLimpieza(cont, lista);
}
function renderIncResueltas(){
  const todas = [...incidencias.values()].filter(i => i.estado === 'resuelta')
    .sort((a, b) => String(b.resuelta_en || b.creada_en).localeCompare(String(a.resuelta_en || a.creada_en)));
  llenarFiltroTipos($('#irTipo'), todas);
  const selQuien = $('#irQuien'), antes = selQuien.value;
  const nombres = [...new Set(todas.map(i => i.atendida_por_nombre).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  selQuien.innerHTML = '<option value="">Atendida por: todos</option>' + nombres.map(n => `<option ${n === antes ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const lista = filtrarInc(todas, $('#irBusca').value, $('#irTipo').value).filter(i => !selQuien.value || i.atendida_por_nombre === selQuien.value);
  $('#irConteo').textContent = todas.length ? `${lista.length} de ${todas.length}` : '';
  const cont = $('#irLista');
  cont.innerHTML = lista.length ? lista.slice(0, 200).map(tarjetaIncidencia).join('')
    : `<div class="vacio-grande">${todas.length ? 'Ninguna incidencia coincide con el filtro.' : 'Todavía no hay incidencias resueltas.'}</div>`;
  enlazar(cont);
  barraLimpieza(cont, lista.slice(0, 200));
}
$('#iaBusca').addEventListener('input', debounce(renderIncAbiertas, 200));
$('#iaTipo').addEventListener('change', renderIncAbiertas);
$('#irBusca').addEventListener('input', debounce(renderIncResueltas, 200));
$('#irTipo').addEventListener('change', renderIncResueltas);
$('#irQuien').addEventListener('change', renderIncResueltas);
['#dlgResolver'].forEach(sel => { const dl = $(sel);
  dl.querySelectorAll('[data-cerrar]').forEach(x => x.addEventListener('click', () => dl.close()));
  dl.addEventListener('click', e => { if (e.target === dl) dl.close(); }); });

/* ================= Sección: Sectores y flujo de agua ================= */
function renderSectoresVista(){
  const sectores = listaSectores();
  const {casas} = datosGenerales();
  const porSector = new Map();
  casas.forEach(l => sectoresDe(l).forEach(id => porSector.set(id, (porSector.get(id) || 0) + 1)));
  const conAgua = sectores.filter(s => s.aq.datos.activo).length;
  $('#secConteo').textContent = sectores.length ? `${conAgua} de ${sectores.length} sectores con agua` : '';
  const cont = $('#secLista');
  if (!sectores.length){
    cont.innerHTML = '<div class="vacio-grande">Aún no hay sectores.<br><small><a href="#/mapa/dibujar/sector">Dibuja el primero en el mapa</a>.</small></div>';
    return;
  }
  cont.innerHTML = sectores.map(l => {
    const d = l.aq.datos, inc = textoIncidencias(l.aq.id), activo = !!d.activo;
    const color = inc ? ROJO : activo ? (l.aq.color || TIPOS.sector.color) : Acu.SIN_FLUJO.relleno;
    const nInc = incAbiertas().filter(i => afectadosPor(i).includes(l.aq.id) || sectoresDe(capas.get(i.forma_id) || l).includes(l.aq.id)).length;
    return `<article class="tarjeta sector-card" style="--color:${esc(color)}">
      <div class="sector-cab">
        <i class="muestra" style="background:${esc(color)}"></i>
        <div><h2>${esc(d.nombre || 'Sector sin nombre')}</h2>
          <p class="nota">${esc((activo ? 'Con agua ' : 'Sin agua ') + (d.activoDesde ? Acu.desde(d.activoDesde) : ''))}</p></div>
        <label class="interruptor" title="Flujo de agua"><input type="checkbox" data-flujo-id="${esc(l.aq.id)}" ${activo ? 'checked' : ''} aria-label="Agua en ${esc(d.nombre || 'sector')}"><span class="riel"></span></label>
      </div>
      ${inc ? `<p class="aviso-inc">⚠ ${esc(inc)}</p>` : ''}
      <div class="stats compactas">
        <div class="stat"><b>${porSector.get(l.aq.id) || 0}</b><span>Casas</span></div>
        <div class="stat ${nInc ? 'rojo' : ''}"><b>${nInc}</b><span>Incidencias</span></div>
        <div class="stat"><b>${Math.round(Acu.opacidadSector(d) * 100)}%</b><span>Opacidad</span></div>
      </div>
      <div class="fila"><button class="btn chico" data-ver="${esc(l.aq.id)}">Ver y editar en el mapa</button></div>
    </article>`;
  }).join('');
  enlazar(cont);
}
function flujoTodos(activo){
  const sectores = listaSectores().filter(l => !!l.aq.datos.activo !== activo);
  if (!sectores.length){ aviso(activo ? 'Todos los sectores ya tienen agua.' : 'Ningún sector tiene agua.'); return; }
  if (!confirm(`¿${activo ? 'Dar agua a' : 'Quitar el agua de'} ${sectores.length} ${sectores.length === 1 ? 'sector' : 'sectores'}?`)) return;
  sectores.forEach(l => ponerFlujo(l, activo));
  aviso(activo ? 'Todos los sectores con agua.' : 'Todos los sectores sin agua.');
}
$('#secTodosOn').addEventListener('click', () => flujoTodos(true));
$('#secTodosOff').addEventListener('click', () => flujoTodos(false));

/* ================= Sección: Casas ================= */
function filasCasas(){
  return datosGenerales().casas.map(l => ({
    l, d:l.aq.datos, c:cuenta(l.aq), conectada:estaConectada(l.aq.id), sector:nombreSectorDe(l), inc:textoIncidencias(l.aq.id)
  }));
}
function renderCasasVista(){
  const todas = filasCasas();
  const q = $('#busca').value.trim().toLowerCase(), f = $('#filtro').value;
  const lista = todas
    .filter(x => !q || [x.d.numero, x.d.responsable, x.d.telefono, x.sector].join(' ').toLowerCase().includes(q))
    .filter(x => f === 'todas' || (f === 'deben' && x.c.saldo > 0) || (f === 'aldia' && x.c.saldo <= 0)
              || (f === 'sinconexion' && !x.conectada) || (f === 'incidencia' && x.inc))
    .sort((a, b) => b.c.saldo - a.c.saldo || String(a.d.numero).localeCompare(String(b.d.numero), 'es', {numeric:true}));
  casasFiltradas = lista;
  $('#casasConteo').textContent = `${lista.length} de ${todas.length} casas`;
  const cont = $('#casasTabla');
  if (!todas.length){
    cont.innerHTML = '<div class="vacio-grande">Aún no hay casas.<br><small><a href="#/mapa/dibujar/casa">Dibuja la primera en el mapa</a>.</small></div>';
    return;
  }
  if (!lista.length){ cont.innerHTML = '<div class="vacio-grande">Ninguna casa coincide con la búsqueda.</div>'; return; }
  cont.innerHTML = `<div class="tabla-cont"><table class="tabla">
    <thead><tr><th>Casa</th><th>Responsable</th><th>Teléfono</th><th class="num">Núcleos</th><th>Sector</th><th>Conexión</th><th>Estado de cuenta</th><th></th></tr></thead>
    <tbody>${lista.map(x => {
      const est = textoEstado(x.c);
      return `<tr>
        <td><b>${esc(nombreCasa(x.d))}</b>${x.inc ? `<br><small class="rojo">⚠ ${esc(x.inc)}</small>` : ''}</td>
        <td>${esc(x.d.responsable || '—')}</td>
        <td>${x.d.telefono ? `<a href="tel:${esc(String(x.d.telefono).replace(/[^\d+]/g, ''))}">${esc(x.d.telefono)}</a>` : '—'}</td>
        <td class="num">${esc(x.d.nucleos || 0)}</td>
        <td>${esc(x.sector || '—')}</td>
        <td><span class="pill ${x.conectada ? 'ok' : 'warn'}">${x.conectada ? 'Conectada' : 'Sin conexión'}</span></td>
        <td><span class="pill ${est.cls}">${esc(est.txt)}</span></td>
        <td><button class="btn chico" data-ver="${esc(x.l.aq.id)}">Ver</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  enlazar(cont);
}
$('#busca').addEventListener('input', debounce(renderCasasVista, 200));
$('#filtro').addEventListener('change', renderCasasVista);
$('#casasCsv').addEventListener('click', () => {
  if (!casasFiltradas.length){ aviso('No hay casas para exportar.'); return; }
  const enc = ['Número','Responsable','Teléfono','Núcleos','Personas','Sector','Conectada','Cuota mensual','Pagado','Saldo','Estado'];
  const filas = casasFiltradas.map(x => [x.d.numero, x.d.responsable, x.d.telefono, x.d.nucleos, x.d.personas, x.sector,
    x.conectada ? 'Sí' : 'No', x.c.cuotaMes.toFixed(2), x.c.pagado.toFixed(2), x.c.saldo.toFixed(2), textoEstado(x.c).txt]);
  const csv = [enc, ...filas].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  descargar('\ufeff' + csv, `casas-${hoyISO()}.csv`, 'text/csv;charset=utf-8');
  aviso('Lista descargada. Se abre con Excel o Google Sheets.');
});

/* ================= Sección: Calendario de incidencias ================= */
let calMes = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
const claveDia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const horaCorta = iso => new Date(iso).toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'});

function renderCalendario(){
  const porDia = new Map();
  incidencias.forEach(i => { const k = claveDia(new Date(i.creada_en)); if (!porDia.has(k)) porDia.set(k, []); porDia.get(k).push(i); });
  const y = calMes.getFullYear(), mo = calMes.getMonth();
  $('#calTitulo').textContent = capitalizar(calMes.toLocaleDateString('es', {month:'long', year:'numeric'}));
  const desfase = (new Date(y, mo, 1).getDay() + 6) % 7;   // la semana empieza el lunes
  const hoy = claveDia(new Date());
  let totalMes = 0;
  let html = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d => `<div class="cal-dow" aria-hidden="true">${d}</div>`).join('');
  for (let i = 0; i < 42; i++){
    const d = new Date(y, mo, 1 - desfase + i);
    if (i === 35 && d.getMonth() !== mo) break;
    const k = claveDia(d), lista = porDia.get(k) || [], enMes = d.getMonth() === mo;
    if (enMes) totalMes += lista.length;
    const abiertas = lista.filter(x => x.estado === 'abierta').length;
    const tipos = [...new Set(lista.map(x => x.tipo))];
    const cls = ['cal-dia', enMes ? '' : 'fuera', k === hoy ? 'hoy' : '', lista.length ? (abiertas ? 'con-abiertas' : 'todas-resueltas') : ''].join(' ');
    const etiqueta = d.toLocaleDateString('es', {weekday:'long', day:'numeric', month:'long'}) + (lista.length ? `, ${lista.length} ${lista.length === 1 ? 'incidencia' : 'incidencias'}` : '');
    html += `<button class="${cls}" data-dia="${k}" aria-label="${esc(etiqueta)}">
      <span class="num">${d.getDate()}</span>
      ${lista.length ? `<span class="cuenta-dia">${lista.length}</span><span class="tipos-dia">${esc(tipos.slice(0, 2).join(', '))}${tipos.length > 2 ? '…' : ''}</span>` : ''}
    </button>`;
  }
  $('#calGrid').innerHTML = html;
  $('#calResumen').textContent = totalMes ? `${totalMes} ${totalMes === 1 ? 'incidencia' : 'incidencias'} este mes` : 'Sin incidencias este mes';
  $('#calGrid').querySelectorAll('[data-dia]').forEach(b => b.addEventListener('click', () => abrirDia(b.dataset.dia)));
}

function abrirDia(k){
  const [y, m, d] = k.split('-').map(Number);
  const ini = new Date(y, m - 1, d), fin = new Date(y, m - 1, d + 1);
  const todas = [...incidencias.values()];
  const porHora = (a, b) => new Date(a.creada_en) - new Date(b.creada_en);
  const ocurrieron = todas.filter(i => { const c = new Date(i.creada_en); return c >= ini && c < fin; }).sort(porHora);
  const seguian = todas.filter(i => { const c = new Date(i.creada_en), r = i.resuelta_en ? new Date(i.resuelta_en) : null; return c < ini && (!r || r >= ini); }).sort(porHora);
  const evento = i => {
    const o = capas.get(i.forma_id), c = new Date(i.creada_en), abierta = i.estado === 'abierta';
    return `<article class="evento ${abierta ? 'abierta' : 'resuelta'}">
      <div class="ev-hora"><b>${esc(horaCorta(i.creada_en))}</b><small>${c >= ini ? 'ocurrió' : esc(c.toLocaleDateString('es', {day:'numeric', month:'short'}))}</small></div>
      <div class="ev-cuerpo">
        <div class="ev-cab"><b>${abierta ? '⚠' : '✓'} ${esc(i.tipo)}</b><span class="pill ${abierta ? 'bad' : 'ok'}">${abierta ? 'Abierta' : 'Resuelta'}</span></div>
        <p class="meta">${esc(o ? titulo(o.aq) : 'Elemento eliminado')}</p>
        ${i.detalle ? `<p>${esc(i.detalle)}</p>` : ''}
        ${textoControl(i)}
        <p class="ev-tiempos">Ocurrió: <b>${esc(Acu.fechaHora(i.creada_en))}</b><br>
          ${i.resuelta_en ? `Resuelta: <b>${esc(Acu.fechaHora(i.resuelta_en))}</b> · duró ${esc(duracion(i.creada_en, i.resuelta_en))}`
                          : `Sigue abierta, ${esc(Acu.hace(i.creada_en).replace('hace ', 'desde hace '))}`}</p>
        <div class="fila">${o ? `<button class="btn chico" data-ver-inc="${esc(i.id)}" data-hist="1">Ver en el mapa</button>` : ''}
          ${esDev() ? `<button class="btn chico peligro" data-borrar-inc-id="${esc(i.id)}">Eliminar</button>` : ''}</div>
      </div></article>`;
  };
  $('#dlgTitulo').textContent = capitalizar(ini.toLocaleDateString('es', {weekday:'long', day:'numeric', month:'long', year:'numeric'}));
  let html = ocurrieron.length ? ocurrieron.map(evento).join('') : '<p class="vacio">No ocurrió ninguna incidencia este día.</p>';
  if (seguian.length) html += `<h3 class="dlg-sub">Seguían abiertas de días anteriores</h3>${seguian.map(evento).join('')}`;
  const cuerpo = $('#dlgCuerpo');
  cuerpo.innerHTML = html;
  cuerpo.querySelectorAll('[data-ver-inc]').forEach(b => b.addEventListener('click', () => $('#dlgDia').close()));
  enlazar(cuerpo);
  $('#dlgDia').showModal();
}
$('#calPrev').addEventListener('click', () => { calMes = new Date(calMes.getFullYear(), calMes.getMonth() - 1, 1); renderCalendario(); });
$('#calNext').addEventListener('click', () => { calMes = new Date(calMes.getFullYear(), calMes.getMonth() + 1, 1); renderCalendario(); });
$('#calHoy').addEventListener('click', () => { const d = new Date(); calMes = new Date(d.getFullYear(), d.getMonth(), 1); renderCalendario(); });
$('#dlgCerrar').addEventListener('click', () => $('#dlgDia').close());
$('#dlgDia').addEventListener('click', e => { if (e.target === $('#dlgDia')) $('#dlgDia').close(); });

/* =====================================================================
   USUARIOS, SOLICITUDES Y REPORTES
   ===================================================================== */
let miPerfil = null;
let solicitudes = [], perfilesLista = [], reportesLista = [];
const esDev = () => !!miPerfil && miPerfil.rol === 'desarrollador';
const URL_ACCESO = () => new URL('../auth/auth.html', location.href).href.split('#')[0].split('?')[0];
const NOMBRE_ROL = {desarrollador:'Desarrollador', administrador:'Administrador', vecino:'Vecino'};
const NOMBRE_ESTADO_REP = {nuevo:'Nuevo', en_revision:'En revisión', atendido:'Atendido', descartado:'Descartado'};
const CLASE_ESTADO_REP = {nuevo:'bad', en_revision:'warn', atendido:'ok', descartado:'nada'};
const telLink = t => t ? `<a href="tel:${esc(String(t).replace(/[^\d+]/g, ''))}">${esc(t)}</a>` : '—';

/* Llama a la Edge Function "usuarios" (crear y eliminar cuentas) */
async function llamarFuncion(cuerpo){
  enVuelo++; pintarSync();
  try {
    const {data, error} = await sb.functions.invoke('usuarios', {body:{...cuerpo, volver_a:URL_ACCESO() + '?modo=invitacion'}});
    if (error){
      let msg = error.message || String(error);
      const resp = error.context;
      if (resp && resp.status === 404) msg = 'NO_INSTALADA';
      else if (resp && typeof resp.json === 'function'){ try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (e){} }
      if (msg === 'NO_INSTALADA' || /failed to send a request|functionsfetcherror|functionsrelayerror/i.test(msg + ' ' + (error.name || '')))
        msg = 'La función «usuarios» no está instalada en Supabase. Sigue los pasos de instalación de la Edge Function.';
      throw new Error(msg);
    }
    return data;
  } catch (e){ aviso(e.message, 9000); return null; }
  finally { enVuelo--; pintarSync(); }
}

async function cargarUsuarios(){
  // Las solicitudes ya revisadas se borran a los 6 meses (como indica la política de privacidad)
  if (!cargarUsuarios.limpio){
    cargarUsuarios.limpio = true;
    const limite = new Date(Date.now() - 183 * 864e5).toISOString();
    sb.from('solicitudes_registro').delete().neq('estado', 'pendiente').lt('revisada_en', limite).then(() => {}, () => {});
  }
  const [s, p, r, c, a] = await Promise.all([
    sb.from('solicitudes_registro').select('*').order('created_at', {ascending:false}).limit(300),
    sb.from('perfiles').select('*').order('created_at', {ascending:true}),
    sb.from('reportes').select('*, perfiles(nombre, celular, numero_casa, email)').order('created_at', {ascending:false}).limit(500),
    sb.from('cargos').select('*'),
    sb.rpc('lista_administradores')
  ]);
  if (!s.error) solicitudes = s.data || [];
  if (!p.error) perfilesLista = p.data || [];
  if (!r.error) reportesLista = r.data || [];
  if (!c.error) cargosLista = c.data || [];
  if (!a.error) adminsLista = a.data || [];
  const yo = adminsLista.find(x => x.id === miPerfil.id);
  if (yo){ Object.assign(miPerfil, {cargo:yo.cargo, genero:yo.genero}); document.querySelectorAll('[data-rol]').forEach(e => { e.textContent = etiquetaCuenta(miPerfil); }); }
  actualizarBadges();
  if (/^usuarios\/|^incidencias\/reportes|^inicio$/.test(vistaActual || '')) renderVistaActual();
}
const cargarUsuariosPronto = debounce(cargarUsuarios, 400);

/* =====================================================================
   CONTRASEÑAS SIN CORREO
   ===================================================================== */
const PALABRAS_CLAVE = ['Agua','Tubo','Llave','Rio','Casa','Sol','Lluvia','Pozo','Monte','Valle','Cerro','Nube','Hoja','Roca','Brisa','Luna'];
function generarClave(){
  const r = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  return `${PALABRAS_CLAVE[r(16)]}-${1000 + r(9000)}-${PALABRAS_CLAVE[r(16)]}`;
}
/* Número para WhatsApp: si el celular no trae código de país, se toma el del WhatsApp del acueducto */
function numeroWhatsapp(cel){
  let dig = String(cel || '').replace(/\D/g, '');
  const propio = String(state.settings.whatsapp || '').replace(/\D/g, '');
  if (dig.length <= 8 && propio.length > 8) dig = propio.slice(0, propio.length - 8) + dig;
  return dig.length >= 8 ? dig : '';
}
/* Ventana con los datos de acceso para entregarlos a la persona */
function mostrarCredenciales({nombre, email, clave, celular}){
  const url = URL_ACCESO();
  const texto = `Hola${nombre ? ' ' + nombre.split(' ')[0] : ''}, tu cuenta del ${state.settings.nombre || 'acueducto'} está lista.\n` +
    `Entra en: ${url}\nCorreo: ${email}\nContraseña temporal: ${clave}\nAl entrar te pediremos cambiarla por una tuya.`;
  const wa = numeroWhatsapp(celular);
  $('#credCuerpo').innerHTML = `
    <p>Entrega estos datos a <b>${esc(nombre || email)}</b>. La contraseña es temporal: al entrar se le pedirá cambiarla.</p>
    <dl class="credenciales">
      <dt>Página de acceso</dt><dd>${esc(url)}</dd>
      <dt>Correo</dt><dd>${esc(email)}</dd>
      <dt>Contraseña</dt><dd class="clave">${esc(clave)}</dd>
    </dl>
    <div class="fila">
      <button class="btn primario" id="credCopiar">Copiar mensaje</button>
      ${wa ? `<a class="btn" href="https://wa.me/${wa}?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : ''}
    </div>
    <p class="nota">Esta contraseña no se guarda en ningún lugar visible: si cierras esta ventana sin copiarla, puedes crear otra con «Nueva contraseña».</p>`;
  $('#credCopiar').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(texto); aviso('Mensaje copiado.'); }
    catch (e){ prompt('Copia este mensaje:', texto); }
  });
  $('#dlgCredenciales').showModal();
}
/* Campo de contraseña con botón "Generar" */
function campoClave(attr, etiqueta){
  return `<label class="campo"><span>${etiqueta}</span><span class="clave-fila">
    <input type="text" ${attr} value="${esc(generarClave())}" autocomplete="off" spellcheck="false" maxlength="72">
    <button type="button" class="btn chico" data-generar title="Crear otra contraseña">Generar</button></span></label>`;
}
function enlazarGenerar(cont){
  cont.querySelectorAll('[data-generar]').forEach(b => b.addEventListener('click', () => { b.previousElementSibling.value = generarClave(); }));
}

/* --- Mi perfil (administradores) --- */
async function guardarMiPerfil(){
  const {data, error} = await sb.rpc('actualizar_mi_perfil', {p_nombre:$('#miNombre').value, p_celular:$('#miCelular').value});
  if (error){ aviso(explicarError(error)); return; }
  aviso(data.mensaje);
  if (data.ok){ miPerfil.nombre = $('#miNombre').value.trim(); miPerfil.celular = $('#miCelular').value.trim();
    document.querySelectorAll('[data-rol]').forEach(e => { e.textContent = etiquetaCuenta(miPerfil); }); cargarUsuarios(); }
}
async function cambiarMiClave(){
  const a = $('#miClave').value, b = $('#miClave2').value, msg = $('#miClaveMsg');
  msg.hidden = false; msg.className = 'mensaje-form mal';
  if (a.length < 8){ msg.textContent = 'La contraseña debe tener al menos 8 caracteres.'; return; }
  if (a !== b){ msg.textContent = 'Las dos contraseñas no coinciden.'; return; }
  const {error} = await sb.auth.updateUser({password:a});
  if (error){
    msg.textContent = /reauthent|recent/i.test(error.message) ? 'Por seguridad, cierra sesión, vuelve a entrar e inténtalo de nuevo.'
      : /same|different/i.test(error.message) ? 'La contraseña nueva debe ser distinta de la actual.' : 'No se pudo cambiar: ' + error.message;
    return;
  }
  await sb.rpc('marcar_clave_cambiada');
  miPerfil.debe_cambiar_clave = false;
  $('#miClave').value = ''; $('#miClave2').value = '';
  $('#miAvisoTemporal').hidden = true;
  msg.className = 'mensaje-form ok'; msg.textContent = 'Contraseña cambiada. Úsala la próxima vez que entres.';
}
function abrirMiPerfil(){
  $('#miNombre').value = miPerfil.nombre || '';
  $('#miCelular').value = miPerfil.celular || '';
  $('#miCorreo').textContent = miPerfil.email || '';
  $('#miCargo').textContent = nombreCargo(miPerfil) || NOMBRE_ROL[miPerfil.rol];
  $('#miAvisoTemporal').hidden = !miPerfil.debe_cambiar_clave;
  $('#miClaveMsg').hidden = true;
  $('#dlgPerfil').showModal();
}
['#dlgCredenciales', '#dlgPerfil'].forEach(sel => {
  const dl = $(sel);
  dl.querySelectorAll('[data-cerrar]').forEach(x => x.addEventListener('click', () => dl.close()));
  dl.addEventListener('click', e => { if (e.target === dl) dl.close(); });
});
$('#miGuardar').addEventListener('click', guardarMiPerfil);
$('#miCambiarClave').addEventListener('click', cambiarMiClave);
document.querySelectorAll('[data-mi-perfil]').forEach(b => b.addEventListener('click', abrirMiPerfil));

/* --- Solicitudes de registro --- */
function opcionesCasas(seleccion){
  const casas = datosGenerales().casas.sort((a, b) => String(a.aq.datos.numero).localeCompare(String(b.aq.datos.numero), 'es', {numeric:true}));
  return '<option value="">Sin vincular a una casa</option>' + casas.map(l =>
    `<option value="${esc(l.aq.id)}" ${l.aq.id === seleccion ? 'selected' : ''}>${esc(nombreCasa(l.aq.datos))}${l.aq.datos.responsable ? ' — ' + esc(l.aq.datos.responsable) : ''}</option>`).join('');
}
function casaPorNumero(numero){
  const n = String(numero || '').trim().toLowerCase();
  return n ? datosGenerales().casas.filter(l => String(l.aq.datos.numero || '').trim().toLowerCase() === n) : [];
}
function renderSolicitudes(){
  const ver = $('#solFiltro').value;
  const lista = solicitudes.filter(s => ver === 'pendientes' ? s.estado === 'pendiente' : s.estado !== 'pendiente');
  const pend = solicitudes.filter(s => s.estado === 'pendiente').length;
  $('#solConteo').textContent = pend ? `${pend} ${pend === 1 ? 'solicitud pendiente' : 'solicitudes pendientes'}` : 'Sin solicitudes pendientes';
  const cont = $('#solLista');
  if (!lista.length){
    cont.innerHTML = `<div class="vacio-grande">${ver === 'pendientes' ? '✓ No hay solicitudes esperando revisión.' : 'Todavía no hay solicitudes revisadas.'}</div>`;
    return;
  }
  cont.innerHTML = lista.map(s => {
    const coinciden = casaPorNumero(s.numero_casa);
    const verif = coinciden.length
      ? coinciden.map(l => `En el mapa, la ${esc(nombreCasa(l.aq.datos))} tiene como responsable a <b>${esc(l.aq.datos.responsable || 'nadie registrado')}</b>${l.aq.datos.telefono ? ' (tel. ' + esc(l.aq.datos.telefono) + ')' : ''}.`).join('<br>')
      : (s.numero_casa ? 'No hay ninguna casa con ese número en el mapa.' : 'No indicó número de casa.');
    const pendiente = s.estado === 'pendiente';
    return `<article class="tarjeta solicitud">
      <header><h2>${esc(s.nombre)}</h2><span class="pill ${pendiente ? 'warn' : s.estado === 'aprobada' ? 'ok' : 'nada'}">${pendiente ? 'Pendiente' : s.estado === 'aprobada' ? 'Aprobada' : 'Rechazada'}</span></header>
      <dl class="datos">
        <dt>Correo</dt><dd>${esc(s.email)}</dd>
        <dt>Celular</dt><dd>${telLink(s.celular)}</dd>
        <dt>Casa</dt><dd>${esc(s.numero_casa || '—')}</dd>
        <dt>Enviada</dt><dd>${esc(Acu.fechaHora(s.created_at))} (${esc(Acu.hace(s.created_at))})</dd>
      </dl>
      <p class="verificacion ${coinciden.length ? 'ok' : 'no'}">${verif}</p>
      ${pendiente ? `
        <label class="campo"><span>Vincular a la casa</span><select data-casa-sol="${esc(s.id)}">${opcionesCasas(coinciden[0] && coinciden[0].aq.id)}</select></label>
        ${esDev() ? `<div class="modo-acceso">
          <label class="check"><input type="radio" name="modo-${esc(s.id)}" value="clave" checked><span><b>Crear su contraseña ahora</b> (no se envía correo)</span></label>
          <div data-caja-clave="${esc(s.id)}">${campoClave(`data-clave-sol="${esc(s.id)}"`, 'Contraseña temporal')}</div>
          <label class="check"><input type="radio" name="modo-${esc(s.id)}" value="correo"><span>Enviarle un correo para que la cree</span></label>
        </div>` : '<p class="nota">Al aprobar, se le enviará un correo para crear su contraseña. Si prefieres no usar el correo, pide al desarrollador que la apruebe.</p>'}
        <div class="fila"><button class="btn primario" data-aprobar="${esc(s.id)}">Aprobar</button><button class="btn peligro" data-rechazar="${esc(s.id)}">Rechazar</button></div>`
      : `<p class="nota">${s.estado === 'aprobada' ? 'Aprobada' : 'Rechazada'} ${s.revisada_en ? 'el ' + esc(Acu.fechaHora(s.revisada_en)) : ''}${s.motivo ? ' · Motivo: ' + esc(s.motivo) : ''}</p>`}
    </article>`;
  }).join('');
  enlazarGenerar(cont);
  cont.querySelectorAll('input[type=radio][name^="modo-"]').forEach(r => r.addEventListener('change', () => {
    const id = r.name.slice(5);
    cont.querySelector(`[data-caja-clave="${id}"]`).hidden = cont.querySelector(`input[name="modo-${id}"]:checked`).value !== 'clave';
  }));
  cont.querySelectorAll('[data-aprobar]').forEach(b => b.addEventListener('click', async () => {
    const s = solicitudes.find(x => x.id === b.dataset.aprobar); if (!s) return;
    const modo = cont.querySelector(`input[name="modo-${s.id}"]:checked`);
    const conClave = !!modo && modo.value === 'clave';
    const clave = conClave ? cont.querySelector(`[data-clave-sol="${s.id}"]`).value.trim() : '';
    if (conClave && clave.length < 8){ aviso('La contraseña debe tener al menos 8 caracteres.'); return; }
    if (!confirm(conClave ? `¿Aprobar a ${s.nombre} con la contraseña «${clave}»?` : `¿Aprobar a ${s.nombre}? Se le enviará un correo a ${s.email}.`)) return;
    b.disabled = true;
    const r = await llamarFuncion({accion:'aprobar_solicitud', id:s.id, casa_id:cont.querySelector(`[data-casa-sol="${s.id}"]`).value, clave});
    if (r && r.ok){
      if (r.con_clave) mostrarCredenciales({nombre:s.nombre, email:s.email, clave, celular:s.celular});
      else aviso(r.mensaje, 8000);
      cargarUsuarios();
    } else b.disabled = false;
  }));
  cont.querySelectorAll('[data-rechazar]').forEach(b => b.addEventListener('click', async () => {
    const s = solicitudes.find(x => x.id === b.dataset.rechazar); if (!s) return;
    const motivo = prompt(`Motivo del rechazo de ${s.nombre} (opcional, solo lo ven los administradores):`, '');
    if (motivo === null) return;
    const ok = await tarea(sb.from('solicitudes_registro').update({estado:'rechazada', motivo:motivo.trim() || null,
      revisada_en:new Date().toISOString(), revisada_por:miPerfil.id}).eq('id', s.id), 'No se pudo rechazar la solicitud');
    if (ok){ aviso('Solicitud rechazada. Esa persona podrá intentarlo de nuevo en 24 horas.', 6000); cargarUsuarios(); }
  }));
}
$('#solFiltro').addEventListener('change', renderSolicitudes);

/* --- Tabla de cuentas (vecinos o administradores) --- */
async function cambiarPerfil(id, cambios, msg){
  const ok = await tarea(sb.from('perfiles').update(cambios).eq('id', id), 'No se pudo actualizar la cuenta');
  if (ok){ if (msg) aviso(msg); cargarUsuarios(); }
}
function accionesCuenta(p, puedeGestionar){
  if (!puedeGestionar || p.id === miPerfil.id) return p.id === miPerfil.id ? '<span class="nota">Tu cuenta</span>' : '';
  return `<div class="fila acciones-cuenta">
    ${p.estado === 'activo'
      ? `<button class="btn chico" data-suspender="${esc(p.id)}">Suspender</button>`
      : `<button class="btn chico" data-reactivar="${esc(p.id)}">Reactivar</button>`}
    ${esDev() ? `<button class="btn chico" data-nueva-clave="${esc(p.id)}" title="Pone una contraseña temporal, sin enviar correos">Nueva contraseña</button>
      ${p.rol === 'vecino' && p.estado === 'activo' ? `<button class="btn chico" data-hacer-admin="${esc(p.id)}">Hacer administrador</button>` : ''}` : ''}
    <button class="btn chico peligro" data-eliminar-cuenta="${esc(p.id)}">Eliminar</button></div>`;
}
function enlazarCuentas(cont){
  const buscar = id => perfilesLista.find(p => p.id === id) || adminsLista.find(p => p.id === id);
  cont.querySelectorAll('[data-suspender]').forEach(b => b.addEventListener('click', () => {
    const p = buscar(b.dataset.suspender);
    if (p && confirm(`¿Suspender la cuenta de ${p.nombre || p.email}? No podrá entrar hasta que la reactives.`)) cambiarPerfil(p.id, {estado:'suspendido'}, 'Cuenta suspendida.');
  }));
  cont.querySelectorAll('[data-reactivar]').forEach(b => b.addEventListener('click', () => cambiarPerfil(b.dataset.reactivar, {estado:'activo'}, 'Cuenta reactivada.')));
  cont.querySelectorAll('[data-hacer-admin]').forEach(b => b.addEventListener('click', () => {
    location.hash = '#/usuarios/administradores';
    setTimeout(() => { $('#ascVecino').value = b.dataset.hacerAdmin; $('#ascCargo').focus(); $('#admAscender').scrollIntoView({block:'center'}); }, 150);
  }));
  cont.querySelectorAll('[data-nueva-clave]').forEach(b => b.addEventListener('click', async () => {
    const p = buscar(b.dataset.nuevaClave) || adminsLista.find(x => x.id === b.dataset.nuevaClave); if (!p) return;
    const clave = prompt(`Contraseña temporal para ${p.nombre || p.email} (mínimo 8 caracteres). Podrá cambiarla al entrar:`, generarClave());
    if (clave === null) return;
    if (clave.trim().length < 8){ aviso('La contraseña debe tener al menos 8 caracteres.'); return; }
    const r = await llamarFuncion({accion:'nueva_clave', id:p.id, clave:clave.trim()});
    if (r && r.ok){ mostrarCredenciales({nombre:p.nombre, email:p.email, clave:clave.trim(), celular:p.celular}); cargarUsuarios(); }
  }));
  cont.querySelectorAll('[data-eliminar-cuenta]').forEach(b => b.addEventListener('click', async () => {
    const p = buscar(b.dataset.eliminarCuenta); if (!p) return;
    if (!confirm(`¿Eliminar definitivamente la cuenta de ${p.nombre || p.email}? Sus reportes se conservan sin su nombre.`)) return;
    const r = await llamarFuncion({accion:'eliminar', id:p.id});
    if (r && r.ok){ aviso(r.mensaje); cargarUsuarios(); }
  }));
  cont.querySelectorAll('[data-casa-perfil]').forEach(s => s.addEventListener('change', () => {
    const l = capas.get(s.value);
    cambiarPerfil(s.dataset.casaPerfil, {casa_id:s.value || null, ...(l ? {numero_casa:l.aq.datos.numero || null} : {})}, 'Casa vinculada.');
  }));
  cont.querySelectorAll('[data-rol-perfil]').forEach(s => s.addEventListener('change', () => {
    const p = buscar(s.dataset.rolPerfil);
    if (!confirm(`¿Cambiar el rol de ${p.nombre || p.email} a ${NOMBRE_ROL[s.value]}?`)){ s.value = p.rol; return; }
    cambiarPerfil(p.id, {rol:s.value}, 'Rol actualizado.');
  }));
}
function tablaCuentas(lista, opciones){
  if (!lista.length) return `<div class="vacio-grande">${opciones.vacio}</div>`;
  return `<div class="tabla-cont"><table class="tabla">
    <thead><tr><th>Nombre</th><th>Correo</th><th>Celular</th><th>Casa</th>${opciones.conRol ? '<th>Rol</th>' : ''}<th>Estado</th><th></th></tr></thead>
    <tbody>${lista.map(p => {
      const casa = p.casa_id && capas.get(p.casa_id);
      const puede = opciones.puedeGestionar(p);
      return `<tr>
        <td><b>${esc(p.nombre || '—')}</b></td>
        <td>${esc(p.email)}</td>
        <td>${telLink(p.celular)}</td>
        <td>${puede && opciones.editarCasa ? `<select data-casa-perfil="${esc(p.id)}" class="sel-chico">${opcionesCasas(p.casa_id)}</select>`
             : esc(casa ? nombreCasa(casa.aq.datos) : (p.numero_casa ? 'Casa ' + p.numero_casa : '—'))}</td>
        ${opciones.conRol ? `<td>${puede && p.id !== miPerfil.id ? `<select data-rol-perfil="${esc(p.id)}" class="sel-chico">
            <option value="administrador" ${p.rol === 'administrador' ? 'selected' : ''}>Administrador</option>
            <option value="desarrollador" ${p.rol === 'desarrollador' ? 'selected' : ''}>Desarrollador</option></select>`
            : `<span class="pill ${p.rol === 'desarrollador' ? 'ok' : 'nada'}">${esc(NOMBRE_ROL[p.rol])}</span>`}</td>` : ''}
        <td><span class="pill ${p.estado === 'activo' ? 'ok' : 'bad'}">${p.estado === 'activo' ? 'Activa' : 'Suspendida'}</span></td>
        <td>${accionesCuenta(p, puede)}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}
function renderVecinos(){
  const q = $('#vecBusca').value.trim().toLowerCase();
  const todos = perfilesLista.filter(p => p.rol === 'vecino');
  const lista = todos.filter(p => !q || [p.nombre, p.email, p.celular, p.numero_casa].join(' ').toLowerCase().includes(q));
  $('#vecConteo').textContent = `${lista.length} de ${todos.length} vecinos`;
  campoClaveVecino();
  const cont = $('#vecTabla');
  cont.innerHTML = tablaCuentas(lista, {vacio: todos.length ? 'Ningún vecino coincide con la búsqueda.' : 'Todavía no hay vecinos con cuenta. Aparecerán aquí al aprobar sus solicitudes.',
    puedeGestionar: () => true, editarCasa: true});
  enlazarCuentas(cont);
}
$('#vecBusca').addEventListener('input', debounce(renderVecinos, 200));
/* --- Administradores: salen de los vecinos; cargos de la junta (solo el desarrollador gestiona) --- */
let cargosLista = [], adminsLista = [];
const cargoDe = id => cargosLista.find(c => c.id === id);
function nombreCargo(p){ const c = p && cargoDe(p.cargo); return c ? (p.genero === 'F' ? c.femenino : c.masculino) : ''; }
function etiquetaCuenta(p){ return (p.nombre ? p.nombre + ' · ' : '') + (nombreCargo(p) || NOMBRE_ROL[p.rol]); }
function opcionesCargo(sel, genero){
  const grupo = (g, titulo) => {
    const l = cargosLista.filter(c => c.grupo === g).sort((a, b) => a.orden - b.orden || a.masculino.localeCompare(b.masculino, 'es'));
    return l.length ? `<optgroup label="${titulo}">${l.map(c => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(genero === 'F' ? c.femenino : c.masculino)}</option>`).join('')}</optgroup>` : '';
  };
  return `<option value="">Sin cargo</option>${grupo('junta', 'Junta directiva')}${grupo('otro', 'Otros cargos')}`;
}
const opcionesTrato = sel => `<option value="M" ${sel !== 'F' ? 'selected' : ''}>Caballero</option><option value="F" ${sel === 'F' ? 'selected' : ''}>Dama</option>`;

function renderAdministradores(){
  const dev = esDev();
  $('#admAviso').hidden = dev;
  $('#admAscender').hidden = !dev;
  $('#admCargos').hidden = !dev;
  const cont = $('#admTabla');
  if (!adminsLista.length){ cont.innerHTML = '<div class="vacio-grande">No hay administradores.</div>'; return; }
  cont.innerHTML = `<div class="tabla-cont"><table class="tabla">
    <thead><tr><th>Nombre</th><th>Cargo</th>${dev ? '<th>Trato</th><th>Correo</th>' : ''}<th>Celular</th><th>Casa</th><th>Estado</th>${dev ? '<th></th>' : ''}</tr></thead>
    <tbody>${adminsLista.map(p => {
      const casa = p.casa_id && capas.get(p.casa_id), yo = p.id === miPerfil.id;
      return `<tr>
        <td><b>${esc(p.nombre || '—')}</b>${p.rol === 'desarrollador' ? ' <span class="pill ok">Desarrollador</span>' : ''}${yo ? ' <span class="nota">(tú)</span>' : ''}</td>
        <td>${dev ? `<select class="sel-chico sel-cargo" data-cargo="${esc(p.id)}">${opcionesCargo(p.cargo, p.genero)}</select>` : esc(nombreCargo(p) || '—')}</td>
        ${dev ? `<td><select class="sel-chico sel-trato" data-genero="${esc(p.id)}">${opcionesTrato(p.genero)}</select></td><td>${esc(p.email || '—')}</td>` : ''}
        <td>${telLink(p.celular)}</td>
        <td>${esc(casa ? nombreCasa(casa.aq.datos) : (p.numero_casa ? 'Casa ' + p.numero_casa : '—'))}</td>
        <td><span class="pill ${p.estado === 'activo' ? 'ok' : 'bad'}">${p.estado === 'activo' ? 'Activa' : 'Suspendida'}</span></td>
        ${dev ? `<td>${yo || p.rol === 'desarrollador' ? '' : `<div class="fila acciones-cuenta">
            ${p.estado === 'activo' ? `<button class="btn chico" data-suspender="${esc(p.id)}">Suspender</button>` : `<button class="btn chico" data-reactivar="${esc(p.id)}">Reactivar</button>`}
            <button class="btn chico" data-nueva-clave="${esc(p.id)}">Nueva contraseña</button>
            <button class="btn chico peligro" data-bajar="${esc(p.id)}">Bajar a vecino</button></div>`}</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
  enlazarCuentas(cont);
  cont.querySelectorAll('[data-cargo]').forEach(s => s.addEventListener('change', () => cambiarPerfil(s.dataset.cargo, {cargo:s.value || null}, 'Cargo actualizado.')));
  cont.querySelectorAll('[data-genero]').forEach(s => s.addEventListener('change', () => cambiarPerfil(s.dataset.genero, {genero:s.value}, 'Listo: el cargo se muestra como ' + (s.value === 'F' ? 'dama.' : 'caballero.'))));
  cont.querySelectorAll('[data-bajar]').forEach(b => b.addEventListener('click', () => {
    const p = adminsLista.find(x => x.id === b.dataset.bajar);
    if (p && confirm(`¿Quitarle la administración a ${p.nombre || 'esta persona'}? Vuelve a ser vecino: conserva su cuenta y sus reportes, pero pierde el cargo y el acceso a la administración.`))
      cambiarPerfil(p.id, {rol:'vecino'}, 'Ahora es vecino.');
  }));
  if (dev){ renderAscender(); renderCargos(); }
}
function renderAscender(){
  const vecinos = perfilesLista.filter(p => p.rol === 'vecino' && p.estado === 'activo')
    .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
  $('#ascVecino').innerHTML = vecinos.length
    ? '<option value="">Elige un vecino</option>' + vecinos.map(p => `<option value="${esc(p.id)}">${esc(p.nombre || p.email)}${p.numero_casa ? ' — casa ' + esc(p.numero_casa) : ''}</option>`).join('')
    : '<option value="">No hay vecinos activos</option>';
  const cargoSel = $('#ascCargo').value;
  $('#ascCargo').innerHTML = opcionesCargo(cargoSel, $('#ascTrato').value);
}
$('#ascTrato').addEventListener('change', () => { const v = $('#ascCargo').value; $('#ascCargo').innerHTML = opcionesCargo(v, $('#ascTrato').value); });
$('#ascBoton').addEventListener('click', () => {
  const id = $('#ascVecino').value, p = perfilesLista.find(x => x.id === id);
  if (!p){ aviso('Elige el vecino que será administrador.'); return; }
  const cargo = $('#ascCargo').value || null, genero = $('#ascTrato').value;
  const nc = nombreCargo({cargo, genero});
  if (!confirm(`¿Dar acceso a la administración a ${p.nombre || p.email}${nc ? ' como ' + nc : ''}?`)) return;
  cambiarPerfil(p.id, {rol:'administrador', cargo, genero}, `${p.nombre || 'La persona'} ahora ${genero === 'F' ? 'es administradora' : 'es administrador'}.`);
});
function renderCargos(){
  const fila = c => `<li><span class="nom"><b>${esc(c.masculino)}</b>${c.femenino !== c.masculino ? ' / ' + esc(c.femenino) : ''}</span>
    ${c.predefinido ? '<span class="nota">predefinido</span>' : `<button class="btn chico peligro" data-borrar-cargo="${esc(c.id)}">Quitar</button>`}</li>`;
  const grupo = g => cargosLista.filter(c => c.grupo === g).sort((a, b) => a.orden - b.orden || a.masculino.localeCompare(b.masculino, 'es')).map(fila).join('');
  $('#cargosLista').innerHTML = `<h3 class="dlg-sub">Junta directiva</h3><ul class="lista-cargos">${grupo('junta')}</ul>
    <h3 class="dlg-sub">Otros cargos</h3><ul class="lista-cargos">${grupo('otro')}</ul>`;
  $('#cargosLista').querySelectorAll('[data-borrar-cargo]').forEach(b => b.addEventListener('click', async () => {
    const c = cargoDe(b.dataset.borrarCargo);
    if (!c || !confirm(`¿Quitar el cargo «${c.masculino}»? Quien lo tenga quedará sin cargo.`)) return;
    if (await tarea(sb.from('cargos').delete().eq('id', c.id), 'No se pudo quitar el cargo')){ aviso('Cargo quitado.'); cargarUsuarios(); }
  }));
}
$('#formCargo').addEventListener('submit', async e => {
  e.preventDefault();
  const masc = $('#cgMasc').value.trim(), fem = $('#cgFem').value.trim() || masc, grupo = $('#cgGrupo').value;
  if (masc.length < 2){ aviso('Escribe el nombre del cargo.'); return; }
  const id = masc.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid();
  if (cargoDe(id)){ aviso('Ese cargo ya existe.'); return; }
  const orden = Math.max(0, ...cargosLista.filter(c => c.grupo === grupo).map(c => c.orden)) + 1;
  if (await tarea(sb.from('cargos').insert({id, masculino:masc, femenino:fem, grupo, orden}), 'No se pudo agregar el cargo')){
    aviso(`Cargo «${masc}» agregado.`); e.target.reset(); cargarUsuarios();
  }
});

/* --- Formularios para invitar directamente --- */
function formInvitar(formSel, rolFijo){
  const f = $(formSel);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f).entries());
    const rol = rolFijo || d.rol;
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    const clave = (d.clave || '').trim();
    if (clave && clave.length < 8){ aviso('La contraseña debe tener al menos 8 caracteres (o déjala vacía para enviar un correo).'); btn.disabled = false; return; }
    const r = await llamarFuncion({accion:'invitar', rol, email:d.email, nombre:d.nombre, celular:d.celular, numero_casa:d.numero_casa, casa_id:d.casa_id || '', clave});
    btn.disabled = false;
    if (r && r.ok){
      if (r.con_clave) mostrarCredenciales({nombre:d.nombre, email:d.email, clave, celular:d.celular});
      else aviso(r.mensaje, 8000);
      f.reset(); if (f.querySelector('[name=clave]')) f.querySelector('[name=clave]').value = generarClave(); cargarUsuarios();
    }
  });
}
function campoClaveVecino(){
  const f = $('#formInvitarVec'), hay = f.querySelector('[name=clave]');
  if (esDev() && !hay){ f.querySelector('.fila').insertAdjacentHTML('beforebegin', campoClave('name="clave"', 'Contraseña temporal (déjala vacía para enviar un correo)')); enlazarGenerar(f); }
  if (!esDev() && hay) hay.closest('.campo').remove();
}
formInvitar('#formInvitarVec', 'vecino');

/* --- Reportes de los vecinos --- */
const capaReporte = L.layerGroup().addTo(map);
function renderReportes(){
  const est = $('#repFiltro').value, q = $('#repBusca').value.trim().toLowerCase();
  const lista = reportesLista.filter(r => (!est || r.estado === est) &&
    (!q || [r.tipo, r.descripcion, r.numero_casa, r.perfiles && r.perfiles.nombre].join(' ').toLowerCase().includes(q)));
  const nuevos = reportesLista.filter(r => r.estado === 'nuevo').length;
  $('#repConteo').textContent = nuevos ? `${nuevos} ${nuevos === 1 ? 'reporte nuevo' : 'reportes nuevos'}` : 'Sin reportes nuevos';
  const cont = $('#repLista');
  if (!lista.length){ cont.innerHTML = `<div class="vacio-grande">${reportesLista.length ? 'Ningún reporte coincide con el filtro.' : 'Todavía no hay reportes de vecinos.'}</div>`; return; }
  cont.innerHTML = lista.map(r => {
    const quien = r.perfiles || {};
    return `<article class="tarjeta reporte">
      <header><h2>${esc(r.tipo)}</h2><span class="pill ${CLASE_ESTADO_REP[r.estado]}">${esc(NOMBRE_ESTADO_REP[r.estado])}</span></header>
      <p class="desc">${esc(r.descripcion)}</p>
      <p class="nota">Por <b>${esc(quien.nombre || 'cuenta eliminada')}</b>${r.numero_casa ? ' · Casa ' + esc(r.numero_casa) : ''}${quien.celular ? ' · ' + telLink(quien.celular) : ''} · ${esc(Acu.fechaHora(r.created_at))} (${esc(Acu.hace(r.created_at))})</p>
      ${r.actualizado_por_nombre ? `<p class="nota">Última actualización: <b>${esc(r.actualizado_por_nombre)}</b>${r.actualizado_en ? ' · ' + esc(Acu.fechaHora(r.actualizado_en)) : ''}</p>` : ''}
      <div class="fila">${r.punto ? `<button class="btn chico" data-ver-rep=""${esc(r.id)}">📍 Ver en el mapa</button>` : '<span class="nota">Sin ubicación marcada</span>'}</div>
      <div class="dos respuesta">
        <label class="campo"><span>Estado</span><select data-estado-rep="${esc(r.id)}">${Object.keys(NOMBRE_ESTADO_REP).map(k => `<option value="${k}" ${k === r.estado ? 'selected' : ''}>${NOMBRE_ESTADO_REP[k]}</option>`).join('')}</select></label>
        <label class="campo"><span>Respuesta para el vecino</span><textarea rows="2" data-resp-rep="${esc(r.id)}" maxlength="1000" placeholder="Ej. Gracias, el equipo va en camino.">${esc(r.respuesta || '')}</textarea></label>
      </div>
      <div class="fila"><button class="btn chico primario" data-guardar-rep="${esc(r.id)}">Guardar</button>
        ${esDev() ? `<button class="btn chico peligro" data-borrar-rep="${esc(r.id)}">Eliminar</button>` : ''}</div>
    </article>`;
  }).join('');
  cont.querySelectorAll('[data-guardar-rep]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.guardarRep;
    const ok = await tarea(sb.from('reportes').update({
      estado:cont.querySelector(`[data-estado-rep="${id}"]`).value,
      respuesta:cont.querySelector(`[data-resp-rep="${id}"]`).value.trim() || null,
      actualizado_en:new Date().toISOString()}).eq('id', id), 'No se pudo guardar el reporte');
    if (ok){ aviso('Reporte actualizado. El vecino verá el estado y la respuesta.'); cargarUsuarios(); }
  }));
  cont.querySelectorAll('[data-borrar-rep]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('¿Eliminar este reporte? No se puede deshacer.')) return;
    const {data, error} = await sb.from('reportes').delete().eq('id', b.dataset.borrarRep).select('id');
    if (error || !(data || []).length){ aviso(error ? explicarError(error) : 'Solo el desarrollador puede borrar reportes.', 6000); return; }
    aviso('Reporte eliminado.'); cargarUsuarios();
  }));
  cont.querySelectorAll('[data-ver-rep]').forEach(b => b.addEventListener('click', () => {
    const r = reportesLista.find(x => x.id === b.dataset.verRep); if (!r || !r.punto) return;
    asegurarMapa();
    capaReporte.clearLayers();
    L.marker([r.punto.lat, r.punto.lng], {icon:L.divIcon({className:'pin-reporte', html:'<span>R</span>', iconSize:[28,28], iconAnchor:[14,14]}), pmIgnore:true, snapIgnore:true})
      .bindTooltip(`Reporte: ${esc(r.tipo)}`, {permanent:true, direction:'top', offset:[0,-14]}).addTo(capaReporte);
    map.setView([r.punto.lat, r.punto.lng], Math.max(map.getZoom(), 18));
    setTimeout(() => capaReporte.clearLayers(), 120000);
  }));
}
$('#repFiltro').addEventListener('change', renderReportes);
$('#repBusca').addEventListener('input', debounce(renderReportes, 200));

/* ================= Sección: Configuración ================= */
function cargarConfigEnFormulario(){
  $('#cfgNombre').value = state.settings.nombre;
  $('#cfgCuota').value = state.settings.cuota;
  $('#cfgMoneda').value = state.settings.moneda;
  $('#cfgColorPago').checked = !!state.settings.colorPorPago;
  $('#cfgWhatsapp').value = state.settings.whatsapp;
  $('#cfgWhatsappMsg').value = state.settings.whatsappMensaje;
  $('#cfgWhatsappActivo').checked = state.settings.whatsappActivo;
  $('#cfgCorreo').value = state.settings.correoContacto;
  probarWhatsapp();
}
function probarWhatsapp(){
  const dig = String(state.settings.whatsapp || '').replace(/\D/g, '');
  $('#cfgWhatsappPrueba').innerHTML = dig.length >= 8
    ? `Prueba el enlace: <a href="https://wa.me/${dig}?text=${encodeURIComponent(state.settings.whatsappMensaje || '')}" target="_blank" rel="noopener">abrir WhatsApp ↗</a>${dig.length < 10 ? ' · ⚠ Parece que falta el código de país (ej. 507).' : ''}`
    : 'Escribe el número con el código de país, por ejemplo +507 6000-0000.';
}
function alCambiarConfig(){
  state.settings.nombre = $('#cfgNombre').value;
  state.settings.cuota = num($('#cfgCuota').value);
  state.settings.moneda = $('#cfgMoneda').value;
  state.settings.colorPorPago = $('#cfgColorPago').checked;
  state.settings.whatsapp = $('#cfgWhatsapp').value.trim();
  state.settings.whatsappMensaje = $('#cfgWhatsappMsg').value;
  state.settings.whatsappActivo = $('#cfgWhatsappActivo').checked;
  state.settings.correoContacto = $('#cfgCorreo').value.trim();
  probarWhatsapp();
  capa.eachLayer(l => { if (l.aq){ aplicarEstilo(l); actualizarTooltip(l); } });
  if (selected){ actualizarTituloPanel(); refrescarCuenta(); }
  renderResumen(); guardarConfig();
}
['#cfgNombre','#cfgCuota','#cfgMoneda','#cfgWhatsapp','#cfgWhatsappMsg','#cfgCorreo'].forEach(s => $(s).addEventListener('input', alCambiarConfig));
$('#cfgWhatsappActivo').addEventListener('change', alCambiarConfig);
$('#cfgColorPago').addEventListener('change', () => { alCambiarConfig(); if (selected) renderPanel(); });

/* ================= Copias de seguridad ================= */
function empaquetar(){
  const features = [];
  capa.eachLayer(l => {
    if (!l.aq) return;
    const gj = l.toGeoJSON();
    gj.properties = JSON.parse(JSON.stringify(l.aq));
    features.push(gj);
  });
  return {app:'mapa-acueducto', version:4, guardado:new Date().toISOString(), settings:state.settings,
    tiposIncidencia:tiposInc, incidencias:[...incidencias.values()],
    geojson:{type:'FeatureCollection', features}};
}

async function subirCopia(data){
  const feats = (data.geojson && data.geojson.features) || [];
  const filas = [], pagos = [];
  feats.forEach(f => {
    const g = f.geometry;
    if (!g || !['Point','Polygon','LineString','MultiLineString'].includes(g.type)) return;
    const p = f.properties || {};
    const id = p.id || uid();
    let tipo = TIPOS[p.tipo] ? p.tipo : 'sin';
    if (tipo === 'sector' && g.type !== 'Polygon') tipo = 'sin';
    const datos = Object.assign({}, p.datos || {});
    const lista = Array.isArray(datos.pagos) ? datos.pagos : [];
    delete datos.pagos;
    filas.push({id, tipo, color:tipo === 'tuberia' ? Acu.COLOR_TUBERIA : (p.color || TIPOS[tipo].color), color_manual:tipo === 'tuberia' ? false : !!p.colorManual, geometria:g, datos, editado_por:CLIENTE_ID});
    lista.forEach(x => { if (num(x.monto) > 0) pagos.push({id:x.id || uid(), forma_id:id, fecha:x.fecha || hoyISO(), monto:num(x.monto), nota:x.nota || ''}); });
  });
  for (let i = 0; i < filas.length; i += 500){
    const {error} = await sb.from('formas').upsert(filas.slice(i, i + 500)); if (error) throw error;
  }
  for (let i = 0; i < pagos.length; i += 500){
    const {error} = await sb.from('pagos').upsert(pagos.slice(i, i + 500)); if (error) throw error;
  }
  if (Array.isArray(data.tiposIncidencia) && data.tiposIncidencia.length){
    const existentes = new Set(tiposInc.map(t => t.nombre.toLowerCase()));
    const nuevos = data.tiposIncidencia.filter(t => t && t.nombre && !existentes.has(String(t.nombre).toLowerCase()))
      .map(t => ({id:t.id || uid(), nombre:t.nombre, orden:t.orden || 100}));
    if (nuevos.length){ const {error} = await sb.from('tipos_incidencia').upsert(nuevos); if (error) throw error; }
  }
  if (Array.isArray(data.incidencias) && data.incidencias.length){
    const ids = new Set(filas.map(f => f.id));
    const incs = data.incidencias.filter(i => i && ids.has(i.forma_id)).map(i => ({
      id:i.id || uid(), forma_id:i.forma_id, tipo:i.tipo || 'Incidencia', detalle:i.detalle || '',
      alcance:['forma','red','sector'].includes(i.alcance) ? i.alcance : 'forma',
      ubicacion:['completo','punto','tramo_ab'].includes(i.ubicacion) ? i.ubicacion : 'completo',
      punto_a:i.punto_a || null, punto_b:i.punto_b || null,
      propagar:typeof i.propagar === 'boolean' ? i.propagar : i.alcance === 'red',
      sectores_enlazados:!!i.sectores_enlazados,
      publica:i.publica !== false, detalle_publico:i.detalle_publico || null,
      sector_id:i.sector_id && ids.has(i.sector_id) ? i.sector_id : null,
      color:i.color || ROJO, opacidad:num(i.opacidad) || 0.75, estado:i.estado === 'resuelta' ? 'resuelta' : 'abierta',
      creada_en:i.creada_en || new Date().toISOString(), resuelta_en:i.resuelta_en || null, editado_por:CLIENTE_ID}));
    for (let i = 0; i < incs.length; i += 500){
      const {error} = await sb.from('incidencias').upsert(incs.slice(i, i + 500)); if (error) throw error;
    }
  }
  if (data.settings){
    const s = data.settings;
    const {error} = await sb.from('configuracion').upsert({id:1, nombre:s.nombre || 'Mi acueducto', cuota:num(s.cuota),
      moneda:s.moneda ?? 'B/.', color_por_pago:!!s.colorPorPago, editado_por:CLIENTE_ID});
    if (error) throw error;
  }
  await cargarTodo();
  mapaAjustado = true; asegurarMapa(); enfocarTodo();
  return {formas:filas.length, pagos:pagos.length};
}

$('#exportar').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(empaquetar(), null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `acueducto-${hoyISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  aviso('Copia descargada.');
});
$('#importarBtn').addEventListener('click', () => $('#importar').click());
$('#importar').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = async () => {
    e.target.value = '';
    let data;
    try { data = JSON.parse(r.result); if (!data.geojson) throw new Error('formato'); }
    catch (err){ aviso('Ese archivo no es una copia válida del mapa del acueducto.'); return; }
    if (!confirm('Se subirán al mapa compartido las formas de esta copia. Las que ya existan con el mismo identificador se reemplazan. ¿Continuar?')) return;
    try { const n = await subirCopia(data); aviso(`Copia cargada: ${n.formas} formas y ${n.pagos} pagos.`); }
    catch (err){ console.error(err); aviso('No se pudo cargar la copia: ' + (err.message || err)); }
  };
  r.readAsText(file);
});
$('#borrarTodo').addEventListener('click', async () => {
  const t = prompt('Esto borra todas las casas, tuberías, llaves, sectores y pagos para todos, también del mapa público. Escribe BORRAR para confirmar.');
  if (t !== 'BORRAR') return;
  const ok = await tarea(sb.from('formas').delete().neq('id', ''), 'No se pudo borrar el mapa');
  if (!ok) return;
  cerrarPanel(); capa.clearLayers(); capas.clear(); pendientes.clear(); incidencias.clear(); geometriaCambio(); renderResumen();
  aviso('Mapa borrado.');
});

async function revisarDatosLocales(){
  let d = null;
  try {
    if (localStorage.getItem(LOCAL_V1_SUBIDO)) return;
    d = JSON.parse(localStorage.getItem(LOCAL_V1) || 'null');
  } catch (e){ return; }
  const n = (d && d.geojson && d.geojson.features || []).length;
  if (!n) return;
  if (!confirm(`Este navegador tiene ${n} formas guardadas de la primera versión del mapa. ¿Subirlas a Supabase?`)) return;
  try {
    const r = await subirCopia(d);
    localStorage.setItem(LOCAL_V1_SUBIDO, new Date().toISOString());
    aviso(`Se subieron ${r.formas} formas y ${r.pagos} pagos.`);
  } catch (err){ console.error(err); aviso('No se pudieron subir los datos anteriores: ' + (err.message || err)); }
}

/* ================= Acceso e inicio ================= */
function mensaje(html){ $('#acceso').hidden = false; $('#accMensaje').innerHTML = html; }
function irAlAcceso(){ location.replace(PAGINA_ACCESO); }

document.querySelectorAll('[data-salir]').forEach(b => b.addEventListener('click', async () => {
  await flush();
  await sb.auth.signOut();
  irAlAcceso();
}));

/* Comprueba que la base de datos tenga todo lo que usa esta versión */
function mostrarAlertaBD(detalle){
  const el = $('#alertaBD');
  el.innerHTML = `<b>⚠ ${esc(MSG_BD_VIEJA)}</b>${detalle ? `<small>Falta: ${esc(detalle)}</small>` : ''}`;
  el.hidden = false;
}
async function verificarBaseDatos(){
  const pruebas = [
    ['incidencias', 'id,ubicacion,punto_a,punto_b,propagar,sectores_enlazados'],
    ['incidencias_publicas', 'id'],
    ['tipos_incidencia', 'id'],
    ['mapa_publico', 'id'],
    ['perfiles', 'id,rol,estado'],
    ['solicitudes_registro', 'id'],
    ['reportes', 'id'],
    ['configuracion', 'id,whatsapp,whatsapp_activo,correo_contacto'],
    ['incidencias', 'id,publica,detalle_publico'],
    ['perfiles', 'id,cargo,genero'],
    ['incidencias', 'id,atendida_por,atendida_por_nombre,nota_cierre'],
    ['cargos', 'id']
  ];
  const faltan = [];
  for (const [tabla, cols] of pruebas){
    const {error} = await sb.from(tabla).select(cols).limit(1);
    if (error && explicarError(error) === MSG_BD_VIEJA) faltan.push(tabla === 'incidencias' ? 'columnas nuevas de incidencias' : 'tabla ' + tabla);
  }
  if (faltan.length) mostrarAlertaBD(faltan.join(', '));
  else $('#alertaBD').hidden = true;
}

async function iniciarApp(session){
  if (appIniciada) return;
  appIniciada = true;
  document.querySelectorAll('[data-correo]').forEach(e => { e.textContent = session.user.email || ''; });
  mensaje('<h2>Verificando acceso…</h2>');
  const {data:perfil, error:errPerfil} = await sb.from('perfiles').select('*').eq('id', session.user.id).maybeSingle();
  if (errPerfil && explicarError(errPerfil) === MSG_BD_VIEJA){
    appIniciada = false;
    mensaje(`<h2>Falta actualizar la base de datos</h2><p>${esc(MSG_BD_VIEJA)}</p><button class="btn primario" onclick="location.reload()">Ya lo ejecuté, recargar</button>`);
    return;
  }
  if (!perfil || perfil.estado !== 'activo' || !['administrador','desarrollador'].includes(perfil.rol)){
    appIniciada = false;
    mensaje(`<h2>Sin acceso a la administración</h2>
      <p>${!perfil ? 'Tu cuenta no tiene permisos de administración. Pide al desarrollador que te dé acceso.'
          : perfil.estado !== 'activo' ? 'Tu cuenta está suspendida.' : 'Tu cuenta es de vecino: desde la página pública puedes ver el mapa y enviar reportes.'}</p>
      <div class="fila"><a class="btn primario" href="../../../index.html">Ir a la página pública</a><button class="btn" id="salirSinAcceso">Cerrar sesión</button></div>`);
    $('#salirSinAcceso').addEventListener('click', async () => { await sb.auth.signOut(); irAlAcceso(); });
    return;
  }
  miPerfil = perfil;
  if (perfil.debe_cambiar_clave) setTimeout(() => { abrirMiPerfil(); aviso('Estás usando una contraseña temporal: cámbiala por una tuya.', 7000); }, 800);
  document.querySelectorAll('[data-rol]').forEach(e => { e.textContent = (perfil.nombre ? perfil.nombre + ' · ' : '') + NOMBRE_ROL[perfil.rol]; });   // se completa con el cargo al cargar
  mensaje('<h2>Cargando el mapa…</h2><p class="nota">Descargando casas, tuberías, llaves, sectores y pagos.</p>');
  try {
    await cargarTodo();
    suscribir();
    $('#acceso').hidden = true;
    router();
    verificarBaseDatos();
    cargarUsuarios();
    pintarSync();
    revisarDatosLocales();
  } catch (err){
    console.error(err);
    appIniciada = false;
    const tablasFaltan = /relation|does not exist|schema cache|violates check/i.test(err.message || '');
    mensaje(`<h2>No se pudo cargar el mapa</h2>
      <p>${tablasFaltan ? 'Parece que la base de datos no está actualizada. Ejecuta el archivo <code>supabase.sql</code> en el SQL Editor de tu proyecto.' : 'Revisa tu conexión a internet.'}</p>
      <p class="nota">${esc(err.message || err)}</p>
      <button class="btn primario" id="reintentar">Reintentar</button>`);
    $('#reintentar').addEventListener('click', () => iniciarApp(session));
  }
}

async function arrancar(){
  marcarBotones();
  renderResumen();
  try { sb = Acu.cliente(); }
  catch (e){ mensaje(`<h2>No se pudo conectar</h2><p>${esc(e.message)}</p>`); return; }
  sb.auth.onAuthStateChange(evento => { if (evento === 'SIGNED_OUT') irAlAcceso(); });
  const {data:{session}} = await sb.auth.getSession();
  if (!session){ irAlAcceso(); return; }
  iniciarApp(session);
}
if (window.__PRUEBAS) window.__acu = {map, capas, redActual, incidencias, seleccionar};   // solo para pruebas automáticas
arrancar();
})();
