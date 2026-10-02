const METODOS_PAGO = Acu.METODOS_PAGO;
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
  casaRect:'Toca una esquina de la casa y arrastra hasta la esquina opuesta. Después la agrandas o achicas desde sus esquinas.',
  casaCuad:'Toca una esquina y arrastra hasta la opuesta: al soltar queda cuadrada. Siempre conserva lados iguales.',
  conectorT:'Toca sobre la tubería donde va la unión en T: se corta sola. Después asignas en el panel la entrada y las salidas.',
  conectorY:'Toca sobre la tubería donde va la unión en Y: se corta sola. Después asignas en el panel la entrada y las salidas.',
  conectorCruz:'Toca sobre la tubería donde va la cruz: se corta sola. Después asignas en el panel la entrada y las salidas.',
  conectorCodo:'Toca el punto donde va el codo (o la punta de una tubería). Después asignas en el panel la entrada y la salida.',
  conectorBuje:'Toca sobre la tubería donde va el buje reductor: se corta sola. Después eliges los diámetros de cada lado.'
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
/* Símbolo de moneda sin números (antes se podía escribir un número por error, por ejemplo "B/.2") */
const limpiarMoneda = v => String(v ?? '').split(/[0-9]/)[0].trim().slice(0, 5) || 'B/.';   // lo que va antes del primer número
const dinero = n => `${limpiarMoneda(state.settings.moneda)} ${num(n).toFixed(2)}`;
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
  if (tipo === 'casa') return {numero:'', responsable:'', telefono:'', nucleos:1, personas:'', inicioCobro:'', cuotaEspecial:'', tarifa:'', cobroActivo:true, notas:''};
  if (tipo === 'tuberia') return {nombre:'', clase:'principal', flujo:'', sectores:[], diametro:'', material:'PVC', notas:''};
  if (tipo === 'llave') return {nombre:'', estado:'abierta', notas:''};
  if (tipo === 'sector') return {nombre:'', opacidad:0.35, activo:false, activoDesde:'', notas:''};
  if (tipo === 'conector') return {nombre:'', forma:'T', rotacion:0, espejo:false, tamano:TAMANO_UNION, notas:''};
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
  if (typeof pintarDetallesPronto === 'function') pintarDetallesPronto();
  if (typeof edicion !== 'undefined' && edicion) pintarEdicion();
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, rapido ? 50 : 700);
}
async function flush(forzar){
  clearTimeout(flushTimer);
  if (typeof edicion !== 'undefined' && edicion && forzar !== true){ pintarSync(); if (typeof pintarEdicion === 'function') pintarEdicion(); return; }
  if (flushEnCurso) await flushEnCurso;
  if (!pendientes.size || !sb){ pintarSync(); return; }
  const ids = [...pendientes]; pendientes.clear();
  const filas = ids.map(id => capas.get(id)).filter(Boolean).map(fila);
  if (!filas.length){ pintarSync(); return; }
  flushEnCurso = (async () => {
    enVuelo++; pintarSync();
    let error = null;
    if (puedeEditarMapa()) ({error} = await sb.from('formas').upsert(filas));
    else {
      // Solo actualizar (no pueden crear formas); la base de datos revisa qué datos pueden cambiar
      for (const f of filas){
        const r = await sb.from('formas').update({datos:f.datos, editado_por:f.editado_por}).eq('id', f.id);
        if (r.error){ error = r.error; break; }
      }
    }
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
    color_por_pago:!!s.colorPorPago, ocultar_red_vecinos:!!s.ocultarRed, whatsapp:s.whatsapp || null, whatsapp_mensaje:s.whatsappMensaje || null,
    whatsapp_activo:!!s.whatsappActivo, correo_contacto:s.correoContacto || null, editado_por:CLIENTE_ID}), 'No se pudo guardar la configuración');
}, 600);

function aqDesdeFila(r){
  const tipo = TIPOS[r.tipo] ? r.tipo : 'sin';
  const datos = Object.assign(datosBase(tipo), r.datos || {});
  delete datos.pagos;
  return {id:r.id, tipo, color:r.color || TIPOS[tipo].color, colorManual:!!r.color_manual, datos};
}
function aplicarFilaConfig(r){
  const monedaGuardada = r.moneda ?? 'B/.';
  if (limpiarMoneda(monedaGuardada) !== monedaGuardada){
    // Se corrige en la base de datos para que también se vea bien en la página de los vecinos
    r = {...r, moneda:limpiarMoneda(monedaGuardada)};
    sb.from('configuracion').update({moneda:r.moneda, editado_por:CLIENTE_ID}).eq('id', 1).then(({error}) => {
      if (!error) aviso(`Se corrigió el símbolo de moneda: tenía un número ("${monedaGuardada}"). Ahora es "${r.moneda}".`, 7000);
    });
  }
  state.settings = {nombre:r.nombre || 'Mi acueducto', cuota:num(r.cuota), moneda:r.moneda ?? 'B/.', colorPorPago:!!r.color_por_pago, tarifaDefecto:r.tarifa_defecto || 'estandar',
    ajusteFondos:r.ajuste_fondos || {}, ocultarRed:!!r.ocultar_red_vecinos, casasEnlazadas:!!r.casas_enlazadas, mesesCorte:r.meses_para_corte ?? 2, diasAvisoCorte:r.dias_aviso_corte ?? 8, montoReconexion:num(r.monto_reconexion),
    politica:r.politica_privacidad || '', politicaFecha:r.politica_actualizada_en || null,
    whatsapp:r.whatsapp || '', whatsappMensaje:r.whatsapp_mensaje || '', whatsappActivo:!!r.whatsapp_activo, correoContacto:r.correo_contacto || ''};
  if (typeof map !== 'undefined' && map.ajustarFondos && !ajusteEdicion) map.ajustarFondos(state.settings.ajusteFondos);
  if ($('#polTexto')) pintarPolitica();
}

async function cargarTodo(){
  const [cfg, formas, , incs, tipos] = await Promise.all([
    sb.from('configuracion').select('*').eq('id', 1).maybeSingle(),
    Acu.traerTodo(sb, 'formas'),
    cargarCobros(),
    Acu.traerTodo(sb, 'incidencias'),
    sb.from('tipos_incidencia').select('*').order('orden').order('nombre')
  ]);
  if (cfg.error) throw cfg.error;
  if (tipos.error) throw tipos.error;
  if (cfg.data) aplicarFilaConfig(cfg.data);
  tiposInc = tipos.data || [];
  incidencias.clear();
  incs.forEach(r => incidencias.set(r.id, r));
  cerrarPanel();
  capa.clearLayers(); capas.clear(); versionGeo++;
  formas.forEach(r => {
    const layer = Acu.capaDesdeGeom(r.geometria, r.datos);
    if (layer) agregarCapa(layer, aqDesdeFila(r));
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
    .on('postgres_changes', {event:'*', schema:'public', table:'pagos'}, p => movimientoEnVivo(pagosDe, p))
    .on('postgres_changes', {event:'*', schema:'public', table:'cobros'}, p => movimientoEnVivo(cobrosDe, p))
    .on('postgres_changes', {event:'*', schema:'public', table:'tarifas'}, cargarTarifas)
    .on('postgres_changes', {event:'*', schema:'public', table:'categorias_casa'}, cargarCategorias)
    .on('postgres_changes', {event:'*', schema:'public', table:'arreglos_pago'}, async p => { await cargarArreglos(); const r = p.new && p.new.forma_id ? p.new : p.old; if (r && r.forma_id) refrescarCobrosUI(r.forma_id); })
    .on('postgres_changes', {event:'*', schema:'public', table:'casas_vecino'}, cargarUsuariosPronto)
    .on('postgres_changes', {event:'*', schema:'public', table:'cortes'}, async p => { await cargarCortes(); const r = p.new && p.new.forma_id ? p.new : p.old; if (r && r.forma_id) refrescarCobrosUI(r.forma_id); actualizarBadgeCortes(); })
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
    .on('postgres_changes', {event:'*', schema:'public', table:'perfiles'}, p => {
      if (p.new && miPerfil && p.new.id === miPerfil.id && p.new.permisos){
        miPerfil.permisos = p.new.permisos; aplicarPermisos(); renderVistaActual();
        aviso('Tus permisos cambiaron.', 4000);
      }
      cargarUsuariosPronto();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'cargos'}, cargarUsuariosPronto)
    .subscribe(status => { enVivo = status === 'SUBSCRIBED'; pintarSync(); });
}
function aplicarFilaForma(r){
  const prev = capas.get(r.id);
  const nueva = Acu.capaDesdeGeom(r.geometria, r.datos); if (!nueva) return;
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
map.pm.addControls({position:'topleft', drawMarker:false, drawCircle:false, drawText:false, drawCircleMarker:true,
  drawPolyline:true, drawRectangle:true, drawPolygon:true, cutPolygon:false, rotateMode:false});
map.pm.removeControls();   // solo aparecen al pulsar «Editar mapa»
map.pm.setGlobalOptions({layerGroup:capa, snappable:true, snapDistance:18});

/* ================= Estilo y etiquetas ================= */
function colorDe(aq){
  if (aq.tipo === 'tuberia') return Acu.COLOR_TUBERIA;
  if (aq.tipo === 'casa' && state.settings.colorPorPago){
    const c = cuenta(aq);
    if (c.aplica) return ESTADO_COLOR[c.nivel];
  }
  if (aq.tipo === 'casa' && !aq.colorManual){ const c = categoriaDe(aq.datos); if (c) return c.color; }
  return aq.color || TIPOS[aq.tipo].color;
}
function marcarClase(layer, cls, si){
  const el = layer.getElement && layer.getElement();
  if (el) el.classList.toggle(cls, !!si);
}
function aplicarEstilo(layer){
  aplicarEstiloBase(layer);
  const aq = layer.aq;
  if (aq && aq.tipo === 'tuberia' && esLinea(layer)) layer.setStyle({weight:Acu.grosorTuberia(aq.datos) + (layer === selected ? 3 : 0)});
  if (!aq || aq.tipo !== 'casa' || !cobrosListos) return;
  const s = situacionCorte(aq, cuenta(aq));
  marcarClase(layer, 'casa-cortada', s.estado === 'cortado');
  if (s.estado === 'cortado') layer.setStyle({color:'#B3261E', weight:3, dashArray:'5 4', fillColor:'#2E3336', fillOpacity:.75});
  else if (['notificar', 'notificado', 'vencido'].includes(s.estado)) layer.setStyle({color:'#E67E22', weight:3, dashArray:'6 4'});
}
function aplicarEstiloBase(layer){
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
  if (aq.tipo === 'conector'){
    const f = Acu.formaDe(d), base = d.forma === 'T' || d.forma === 'Y' || !d.forma ? 'Unión en ' + f.nombre : f.nombre;
    return base + (d.forma === 'buje' && Array.isArray(d.tamanos) ? ` ${d.tamanos[0] || '?'}" → ${d.tamanos[1] || '?'}"` : '') + (d.nombre ? ': ' + d.nombre : '');
  }
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
    if (layer._cuadrando) return;
    if (layer.aq.datos && layer.aq.datos.cuadrado && esPoligono(layer)){ layer._cuadrando = true; try { cuadrar(layer); } finally { layer._cuadrando = false; } }
    else if (layer.aq.datos && layer.aq.datos.rectangulo && esPoligono(layer) && !(layer instanceof L.Rectangle)){
      layer._cuadrando = true;
      try { const m = medidasRect(layer); layer.setLatLngs(esquinasRect(m.centro, m.ancho, m.alto, m.ang));
        if (layer.pm.enabled()){ layer.pm.disable(); layer.pm.enable({allowSelfIntersection:false}); } } finally { layer._cuadrando = false; }
    }
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
  if (!requiereEdicion()) return;
  const id = layer.aq.id;
  quitarCapaLocal(layer);
  pendientes.delete(id);
  if (edicion.foto.has(id)) edicion.borrados.add(id);   // se borra al guardar
  pintarEdicion();
  renderResumen();
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
function geometriaCambio(){ versionGeo++; recalcularPronto(); flechasPronto(); if (typeof pintarDetallesPronto === 'function') pintarDetallesPronto(); }

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
  calcularCierres();
  publicarEfectos();
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
/* El nombre guardado se conserva; aquí solo se indica si la persona ya no está en la administración */
function situacionCuenta(id){
  if (!id || adminsLista.some(a => a.id === id)) return '';
  if (perfilesLista.some(p => p.id === id)) return ' <span class="ex">(ya no es administrador)</span>';
  return ' <span class="ex">(cuenta eliminada)</span>';
}
function textoControl(inc){
  const filas = [];
  if (inc.creado_por_nombre) filas.push(`📝 Registró: <b>${esc(inc.creado_por_nombre)}</b>${situacionCuenta(inc.creado_por)}`);
  if (inc.estado === 'resuelta'){
    if (inc.atendida_por_nombre) filas.push(`🔧 Atendió: <b>${esc(inc.atendida_por_nombre)}</b>${situacionCuenta(inc.atendida_por)}`);
    if (inc.resuelta_por_nombre && inc.resuelta_por_nombre !== inc.atendida_por_nombre) filas.push(`✅ Marcó como resuelta: <b>${esc(inc.resuelta_por_nombre)}</b>${situacionCuenta(inc.resuelta_por)}`);
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
    const dc = mejor.c.aq.datos, tam = dc.forma === 'buje' && Array.isArray(dc.tamanos) ? dc.tamanos[libre.k] : null;
    if (tam){ d.diametro = tam; msgs.push(`Diámetro ajustado a ${tam}" por el buje reductor.`); }
    const rol = pr.roles[libre.k];
    if (!rol){ msgs.push(`Unida a la punta ${libre.k + 1} (libre).`); return; }
    d.flujo = flujoEnPuerto(ext, rol === 'entrada');
    msgs.push(`Unida a la punta ${libre.k + 1} (${rol}); dirección del agua ajustada.`);
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
  con.aq.datos.puertos = Acu.rolesConector(con.aq.datos);    // el rol de cada punta queda guardado explícitamente
  delete con.aq.datos.entrada;
  moverUnidas(con, unidas);
  // El rol de cada punta decide la dirección del agua; el buje, el diámetro
  const roles = con.aq.datos.puertos, d = con.aq.datos;
  unidas.forEach((u, k) => {
    if (!u || k >= roles.length) return;
    let cambiada = false;
    if (roles[k]){ const f = flujoEnPuerto(u.extremo, roles[k] === 'entrada'); if (u.layer.aq.datos.flujo !== f){ u.layer.aq.datos.flujo = f; cambiada = true; } }
    if (d.forma === 'buje' && Array.isArray(d.tamanos) && d.tamanos[k] && u.layer.aq.datos.diametro !== d.tamanos[k]){ u.layer.aq.datos.diametro = d.tamanos[k]; cambiada = true; }
    if (cambiada){ guardarForma(u.layer.aq.id); aplicarEstilo(u.layer); }
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
  ramal:'Toca sobre la tubería donde nace el ramal (punto A) y ve tocando hasta el punto B. Si B está en una casa, se te preguntará si quieres conectarla. Toca el último punto otra vez para terminar.',
  casaCasa:'El trazo ya empieza en esta casa: ve tocando hasta la casa que recibe el agua y toca el último punto otra vez.',
  acometida:'Empieza tocando sobre la tubería y termina dentro de la casa. Toca el último punto otra vez para terminar.',
  salida:'El trazo empieza en el brazo de la unión: ve tocando el camino y toca el último punto otra vez para terminar.',
  entrada:'Empieza donde viene el agua y termina en la punta del brazo de entrada de la unión.'
};
/* =====================================================================
   DETALLES DE TUBERÍA EN EL MAPA: diámetro y longitud de cada tubería,
   y las medidas de cada buje reductor. Se activan con un botón.
   ===================================================================== */
const CLAVE_DETALLES = 'acu-detalles-tuberia', ZOOM_DETALLES = 16;
map.createPane('detalles').style.zIndex = 640;          // por encima de las formas y las incidencias
const capaDetalles = L.layerGroup().addTo(map);
let verDetalles = (() => { try { return localStorage.getItem(CLAVE_DETALLES) === '1'; } catch (e){ return false; } })();
const textoDiametro = v => { const t = String(v ?? '').trim().replace(/["”]/g, ''); return t ? t + '"' : ''; };
const textoLargo = m => m >= 1000 ? (m / 1000).toFixed(2).replace('.', ',') + ' km' : m >= 10 ? Math.round(m) + ' m' : (Math.round(m * 10) / 10).toString().replace('.', ',') + ' m';
/* Punto a una fracción del recorrido de una línea (0,5 = la mitad) y el ángulo del tramo donde cae (en pantalla) */
function mitadDeLinea(pts, fraccion = 0.5){
  let total = 0; const tramos = [];
  for (let i = 1; i < pts.length; i++){ const d = map.distance(pts[i - 1], pts[i]); tramos.push(d); total += d; }
  let falta = total * fraccion;
  for (let i = 0; i < tramos.length; i++){
    if (falta <= tramos[i] || i === tramos.length - 1){
      const f = tramos[i] ? Math.min(1, falta / tramos[i]) : 0, a = pts[i], b = pts[i + 1];
      const p = L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f);
      const pa = map.project(a), pb = map.project(b);
      let ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;           // que siempre se lea de izquierda a derecha
      return {p, ang};
    }
    falta -= tramos[i];
  }
  return {p:pts[0], ang:0};
}
/* Coloca cada etiqueta en el primer lugar libre (para que no se tapen entre sí ni con los nombres de los sectores) */
function acomodarEtiquetas(){
  const ocupado = [...document.querySelectorAll('.etq-sector')].map(e => e.getBoundingClientRect());
  const choca = r => ocupado.some(o => r.left < o.right + 3 && r.right > o.left - 3 && r.top < o.bottom + 3 && r.bottom > o.top - 3);
  // primero los bujes (son pocos y van sobre las tuberías), después las tuberías más largas
  const lista = [...capaDetalles.getLayers()].sort((a, b) => (b._prioridad || 0) - (a._prioridad || 0));
  lista.forEach(m => {
    const span = m.getElement() && m.getElement().querySelector('span'); if (!span) return;
    let elegido = null;
    const probar = lug => { if (lug.p) m.setLatLng(lug.p); span.style.transform = lug.t; return span.getBoundingClientRect(); };
    for (const lug of m._lugares){ const r = probar(lug); if (!choca(r)){ elegido = r; break; } }
    if (!elegido){ elegido = probar(m._lugares[0]); span.classList.add('apretada'); }
    ocupado.push(elegido);
  });
}
function pintarDetalles(){
  capaDetalles.clearLayers();
  const boton = document.getElementById('btnDetalles');
  if (boton){ boton.setAttribute('aria-pressed', String(verDetalles)); boton.classList.toggle('activo', verDetalles); }
  if (!verDetalles || map.getZoom() < ZOOM_DETALLES) return;
  const vista = map.getBounds().pad(0.3);
  capas.forEach(l => {
    if (!l.aq) return;
    if (l.aq.tipo === 'tuberia' && esLinea(l)){
      const pts = puntosDe(l); if (pts.length < 2 || !pts.some(p => vista.contains(p))) return;
      const {p, ang} = mitadDeLinea(pts), diam = textoDiametro(l.aq.datos.diametro);
      const largo = longitud(l), txt = (diam ? `<b>${esc(diam)}</b> · ` : '<b class="sin" title="Sin diámetro">Ø ?</b> · ') + esc(textoLargo(largo));
      const rot = `translate(-50%,-50%) rotate(${ang.toFixed(1)}deg)`;
      const m = L.marker(p, {pane:'detalles', interactive:false, keyboard:false,
        icon:L.divIcon({className:'det-tubo' + (l.aq.datos.clase === 'acometida' ? ' acometida' : ''), iconSize:null,
          html:`<span style="transform:${rot} translateY(-15px)">${txt}</span>`})});
      // Lugares posibles: a ambos lados de la línea, primero en la mitad y luego corriéndose hacia las puntas
      m._lugares = [];
      [0.5, 0.35, 0.65, 0.22, 0.78].forEach(f => {
        const q = f === 0.5 ? {p, ang} : mitadDeLinea(pts, f), r2 = `translate(-50%,-50%) rotate(${q.ang.toFixed(1)}deg)`;
        [-15, 15].forEach(dy => m._lugares.push({p:q.p, t:`${r2} translateY(${dy}px)`}));
      });
      m._lugares.push({p, t:`${rot} translateY(-32px)`}, {p, t:`${rot} translateY(32px)`});
      m._prioridad = largo;
      m.addTo(capaDetalles);
    } else if (l.aq.tipo === 'conector' && l.aq.datos.forma === 'buje' && esPunto(l)){
      const c = l.getLatLng(); if (!vista.contains(c)) return;
      const t = Array.isArray(l.aq.datos.tamanos) ? l.aq.datos.tamanos : [];
      const m = L.marker(c, {pane:'detalles', interactive:false, keyboard:false,
        icon:L.divIcon({className:'det-tubo buje', iconSize:null,
          html:`<span style="transform:translate(-50%,-50%) translate(48px,-22px)">Buje <b>${esc(textoDiametro(t[0]) || '?')} → ${esc(textoDiametro(t[1]) || '?')}</b></span>`})});
      m._lugares = [[48, -22], [-48, -22], [48, 22], [-48, 22], [0, -34], [0, 34]].map(([x, y]) => ({t:`translate(-50%,-50%) translate(${x}px,${y}px)`}));
      m._prioridad = 1e9;
      m.addTo(capaDetalles);
    }
  });
  acomodarEtiquetas();
}
const pintarDetallesPronto = debounce(pintarDetalles, 150);
map.on('zoomend moveend', pintarDetallesPronto);
/* Botón en el mapa */
const ControlDetalles = L.Control.extend({
  options:{position:'topright'},
  onAdd(){
    const b = L.DomUtil.create('button', 'btn-detalles');
    b.id = 'btnDetalles'; b.type = 'button';
    b.innerHTML = '<span aria-hidden="true">📏</span> Detalles de tuberías';
    b.title = 'Mostrar u ocultar el diámetro y la longitud de cada tubería';
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, 'click', () => {
      verDetalles = !verDetalles;
      try { localStorage.setItem(CLAVE_DETALLES, verDetalles ? '1' : '0'); } catch (e){}
      pintarDetalles();
      if (verDetalles && map.getZoom() < ZOOM_DETALLES) aviso('Acércate un poco más al mapa para ver los detalles de las tuberías.', 4000);
    });
    return b;
  }
});
new ControlDetalles().addTo(map);

/* =====================================================================
   GIRAR FORMAS: asa ⟳ en el mapa (de 5° en 5°) y botones en el panel.
   Casas (también rectangulares y cuadradas), sectores, conectores y formas sin función.
   Ángulos: positivo = antihorario (como la orientación de los conectores).
   ===================================================================== */
const normalGrados = g => { g = ((Math.round(g) % 360) + 360) % 360; return g > 180 ? g - 360 : g; };
function puedeGirar(l){
  if (!l || !l.aq || !['casa', 'sector', 'conector', 'sin'].includes(l.aq.tipo)) return false;
  return l.aq.tipo === 'conector' ? esPunto(l) : esPoligono(l);
}
function anilloLL(l){ let a = l.getLatLngs(); while (Array.isArray(a[0])) a = a[0]; return a; }
function centroForma(l){
  if (esPunto(l)) return l.getLatLng();
  const pts = anilloLL(l);
  return L.latLng(pts.reduce((s, p) => s + p.lat, 0) / pts.length, pts.reduce((s, p) => s + p.lng, 0) / pts.length);
}
function rotarPuntos(pts, c, grados){
  const [mLat, mLng] = metrosPorGrado(c), t = grados * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
  return pts.map(p => { const x = (p.lng - c.lng) * mLng, y = (p.lat - c.lat) * mLat;
    return L.latLng(c.lat + (x * si + y * co) / mLat, c.lng + (x * co - y * si) / mLng); });
}
/* Medidas de una casa rectangular girada: centro, ancho y alto en su propia orientación */
function medidasRect(l){
  const ang = num(l.aq.datos.rotacion), c0 = centroForma(l), [mLat, mLng] = metrosPorGrado(c0);
  const loc = rotarPuntos(anilloLL(l), c0, -ang).map(p => [(p.lng - c0.lng) * mLng, (p.lat - c0.lat) * mLat]);
  const xs = loc.map(p => p[0]), ys = loc.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const cLoc = L.latLng(c0.lat + cy / mLat, c0.lng + cx / mLng), centro = rotarPuntos([cLoc], c0, ang)[0];
  return {centro, ancho:Math.max(...xs) - Math.min(...xs), alto:Math.max(...ys) - Math.min(...ys), ang};
}
function esquinasRect(c, ancho, alto, ang){
  const [mLat, mLng] = metrosPorGrado(c), w = ancho / 2, h = alto / 2;
  return rotarPuntos([[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => L.latLng(c.lat + y / mLat, c.lng + x / mLng)), c, ang);
}
/* Un rectángulo que se gira se vuelve polígono (misma forma, mismo id, sin cerrar el panel) */
function aPoligono(l){
  if (!(l instanceof L.Rectangle)) return l;
  const aq = l.aq, nueva = L.polygon(anilloLL(l).map(p => L.latLng(p.lat, p.lng)));
  capa.removeLayer(l); map.removeLayer(l); capas.delete(aq.id);
  capa.addLayer(nueva); capas.set(aq.id, nueva); prepararCapa(nueva, aq);
  if (selected === l){ selected = nueva; aplicarEstilo(nueva); }
  return nueva;
}
/* Gira una forma "grados" (antihorario) alrededor de su centro */
function girarForma(l, grados, vivo){
  if (!grados) return l;
  if (l.aq.tipo === 'conector'){ cambiarConector(l, {rotacion:(num(l.aq.datos.rotacion) + grados + 360) % 360}, vivo); return l; }
  l = aPoligono(l);
  l.setLatLngs(rotarPuntos(anilloLL(l), centroForma(l), grados));
  l.aq.datos.rotacion = normalGrados(num(l.aq.datos.rotacion) + grados);
  if (!vivo){ guardarForma(l.aq.id); geometriaCambio(); if (selected === l) renderPanel(); }
  return l;
}
/* Asa de giro sobre la forma seleccionada (solo en «Editar mapa») */
let asaGiro = null;
function actualizarAsaGiro(){
  if (asaGiro){ map.removeLayer(asaGiro); asaGiro = null; }
  const l = selected;
  if (typeof edicion === 'undefined' || !enEdicion() || !puedeGirar(l) || editando || !map.hasLayer(l)) return;
  const c = centroForma(l), cp = map.latLngToLayerPoint(c);
  let arriba;
  if (l.aq.tipo === 'conector') arriba = cp.y - Math.max(34, Acu.tamanoConector(l.aq.datos) * 110540 / 40075016 * 256 * Math.pow(2, map.getZoom()) / 360 + 28);
  else arriba = map.latLngToLayerPoint(L.latLng(l.getBounds().getNorth(), c.lng)).y - 30;
  const pos = map.layerPointToLatLng(L.point(cp.x, arriba));
  asaGiro = L.marker(pos, {draggable:true, zIndexOffset:3000, keyboard:false,
    icon:L.divIcon({className:'asa-giro', html:'<span title="Arrastra para girar">⟳</span>', iconSize:[32, 32], iconAnchor:[16, 16]})}).addTo(map);
  asaGiro.bindTooltip('Arrastra para girar', {direction:'top', offset:[0, -16]});
  let base = null;
  asaGiro.on('dragstart', () => {
    let capaG = selected; if (capaG.aq.tipo !== 'conector') capaG = aPoligono(capaG);
    const centro = centroForma(capaG), cpx = map.latLngToContainerPoint(centro), p0 = map.latLngToContainerPoint(asaGiro.getLatLng());
    base = {capa:capaG, centro, cpx, a0:Math.atan2(-(p0.y - cpx.y), p0.x - cpx.x), rot0:num(capaG.aq.datos.rotacion),
      pts:capaG.aq.tipo === 'conector' ? null : anilloLL(capaG).map(p => L.latLng(p.lat, p.lng))};
  });
  asaGiro.on('drag', e => {
    if (!base) return;
    const p = map.latLngToContainerPoint(e.latlng), a = Math.atan2(-(p.y - base.cpx.y), p.x - base.cpx.x);
    let delta = Math.round(((a - base.a0) * 180 / Math.PI) / 5) * 5;
    delta = normalGrados(delta);
    base.delta = delta;
    if (base.capa.aq.tipo === 'conector') cambiarConector(base.capa, {rotacion:(base.rot0 + delta + 360) % 360}, true);
    else { base.capa.setLatLngs(rotarPuntos(base.pts, base.centro, delta)); base.capa.aq.datos.rotacion = normalGrados(base.rot0 + delta); }
    asaGiro.setTooltipContent(`${delta > 0 ? '↺ ' : delta < 0 ? '↻ ' : ''}${Math.abs(delta)}°`);
  });
  asaGiro.on('dragend', () => {
    if (!base) return;
    const l2 = base.capa, d = base.delta || 0; base = null;
    if (l2.aq.tipo === 'conector') cambiarConector(l2, {rotacion:num(l2.aq.datos.rotacion)});
    else if (d){ guardarForma(l2.aq.id); geometriaCambio(); }
    renderPanel();
    if (d) aviso(`Forma girada ${Math.abs(d)}° ${d > 0 ? 'a la izquierda' : 'a la derecha'}.`);
  });
}
map.on('zoomend', () => { if (asaGiro) actualizarAsaGiro(); });
/* Controles de giro en el panel */
function controlesGiro(l){
  if (!enEdicion() || !puedeGirar(l) || l.aq.tipo === 'conector') return '';
  const ang = normalGrados(num(l.aq.datos.rotacion));
  return `<div class="p-giro"><span class="t">Girar</span>
    <button class="btn chico" data-giro="90" title="90° a la izquierda">↺ 90°</button>
    <button class="btn chico" data-giro="15" title="15° a la izquierda">↺ 15°</button>
    <label class="ang"><input type="number" id="giroAng" min="-180" max="180" step="1" value="${ang}" aria-label="Ángulo">°</label>
    <button class="btn chico" data-giro="-15" title="15° a la derecha">↻ 15°</button>
    <button class="btn chico" data-giro="-90" title="90° a la derecha">↻ 90°</button>
    <p class="nota">También puedes arrastrar el asa <b>⟳</b> que aparece sobre la forma.</p></div>`;
}
function enlazarGiro(l, cuerpo){
  cuerpo.querySelectorAll('[data-giro]').forEach(b => b.addEventListener('click', () => girarForma(selected, Number(b.dataset.giro))));
  const inp = cuerpo.querySelector('#giroAng');
  if (inp) inp.addEventListener('change', () => girarForma(selected, normalGrados(num(inp.value) - num(selected.aq.datos.rotacion))));
}

/* Metros por grado de latitud y de longitud en un punto (medidos igual que el mapa) */
function metrosPorGrado(c){
  const p = L.latLng(c.lat, c.lng);
  return [p.distanceTo(L.latLng(c.lat + 0.001, c.lng)) / 0.001, p.distanceTo(L.latLng(c.lat, c.lng + 0.001)) / 0.001];
}
/* Casa cuadrada: lados iguales alrededor de su centro (el lado más largo, o el indicado) */
function cuadrar(layer, lado){
  if (!(layer instanceof L.Rectangle)){
    const m = medidasRect(layer), s = Math.max(1, lado || Math.max(m.ancho, m.alto));
    layer.setLatLngs(esquinasRect(m.centro, s, s, m.ang));
    if (layer.pm && layer.pm.enabled && layer.pm.enabled()){ layer.pm.disable(); layer.pm.enable({allowSelfIntersection:false}); }
    return;
  }
  const b = layer.getBounds(), c = b.getCenter();
  const ancho = b.getSouthWest().distanceTo(b.getSouthEast()), alto = b.getSouthWest().distanceTo(b.getNorthWest());
  const s = Math.max(1, lado || Math.max(ancho, alto)), [mLat, mLng] = metrosPorGrado(c), dLat = s / 2 / mLat, dLng = s / 2 / mLng;
  layer.setBounds([[c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]]);
  // si se estaba editando, las esquinas se reacomodan a la nueva forma
  if (layer.pm && layer.pm.enabled && layer.pm.enabled()){ layer.pm.disable(); layer.pm.enable({allowSelfIntersection:false}); }
}
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
  if (!requiereEdicion()) return;
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
  // La ÚNICA forma de conectar una casa: un ramal que termina en ella, con confirmación
  if (tr.tipo === 'ramal' && destino){
    if (!confirm(`¿Desea conectar esta línea a ${titulo(destino.aq)}?\n\nSi aceptas, la casa recibirá el agua por este ramal. Si no, el ramal se cancela.`)) return {cancelar:true};
    d.casaDestino = destino.aq.id;
    d.clase = 'acometida'; d.diametro = d.diametro || '1/2';
    d.nombre = 'Acometida de ' + nombreCorto(destino);
    msg = `Listo: la línea quedó conectada a ${titulo(destino.aq)}.`;
  }
  if (destino && esPunto(destino) && d.casaDestino) pts[pts.length - 1] = destino.getLatLng();
  d.flujo = 'adelante';
  ponerPuntos(layer, pts);
  return msg;
}

/* ================= Dibujo ================= */
function iniciarDibujo(t){
  if (!requiereEdicion()) return;
  asegurarMapa();
  salirHistorico();
  if (pendingTipo === t){ map.pm.disableDraw(); pendingTipo = null; marcarBotones(); return; }
  map.pm.disableDraw();
  pendingTipo = t;
  trazado = null;
  map.pm.enableDraw(t.startsWith('conector') ? 'CircleMarker' : (t === 'casaRect' || t === 'casaCuad') ? 'Rectangle' : TIPOS[t].dibujo, {snappable:true});
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
  const formaConector = {conectorT:'T', conectorY:'Y', conectorCruz:'cruz', conectorCodo:'codo', conectorBuje:'buje'}[tipo] || null;
  if (formaConector) tipo = esPunto(layer) ? 'conector' : 'sin';
  const cuadrada = tipo === 'casaCuad', rectangular = tipo === 'casaRect' || cuadrada;
  if (rectangular) tipo = 'casa';
  if (tipo === 'sector' && !esPoligono(layer)) tipo = 'sin';
  if (tipo === 'tuberia' && !esLinea(layer)) tipo = 'sin';
  const aq = {id:uid(), tipo, color:TIPOS[tipo].color, colorManual:false, datos:datosBase(tipo)};
  if (tipo === 'tuberia') aq.datos.flujo = 'adelante';
  if (rectangular){ aq.datos.rectangulo = true; aq.datos.categoria = 'casa'; }
  if (cuadrada){ aq.datos.cuadrado = true; cuadrar(layer); }
  if (tipo === 'casa' && !aq.datos.categoria) aq.datos.categoria = 'casa';
  if (tipo === 'conector'){
    aq.datos.forma = formaConector;
    aq.datos.puertos = Acu.rolesConector({forma:formaConector, puertos:[]});    // todas las puntas libres
    if (formaConector === 'buje') aq.datos.tamanos = ['3', '2'];
  }
  agregarCapa(layer, aq);
  let msg = '';
  if (tipo === 'tuberia'){
    if (tr) msg = completarTrazado(layer, tr);
    if (msg && msg.cancelar){
      quitarCapaLocal(layer); pendientes.delete(aq.id); pintarEdicion();
      aviso('Conexión cancelada: el ramal no se creó.', 5000);
      return;
    }
    const union = ajustarAConectores(layer);
    if (union) msg = (msg ? msg + ' ' : '') + union;
    const cruza = redActual().sectoresQueCruza(layer);
    aq.datos.sectores = [...new Set([...(aq.datos.sectores || []), ...cruza])];
    geometriaCambio();
  }
  if (tipo === 'conector'){
    map.pm.disableDraw(); pendingTipo = null; marcarBotones(); colocarConector(layer);
    cambiarConector(layer, {});    // aplica a las tuberías unidas los diámetros del buje y los roles de las puntas
  }
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
  if (asaGiro){ map.removeLayer(asaGiro); asaGiro = null; }
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
   PERMISOS DE LOS ADMINISTRADORES (los define el desarrollador)
   Cada permiso oculta sus secciones y botones cuando está desactivado.
   La base de datos también los revisa para las acciones importantes.
   ===================================================================== */
const PERMISOS = [
  {grupo:'Secciones que puede ver', items:[
    {k:'mapa', txt:'Mapa de la red', desc:'Ver casas, tuberías, llaves y sectores en el mapa.', rutas:['mapa']},
    {k:'incidencias', txt:'Incidencias', desc:'Abiertas, resueltas y calendario.', rutas:['incidencias/abiertas', 'incidencias/resueltas', 'incidencias/calendario']},
    {k:'reportes', txt:'Reportes de vecinos', desc:'Lo que envían los vecinos desde su página.', rutas:['incidencias/reportes']},
    {k:'sectores', txt:'Sectores y flujo', desc:'Lista de sectores y su servicio de agua.', rutas:['sectores']},
    {k:'resumen', txt:'Resumen general', desc:'Cifras de la red, casas y cobros.', rutas:['resumen']},
    {k:'cobros', txt:'Cobros', desc:'Resumen de cobros, casas y cuentas, historial de cobros.', rutas:['cobros/resumen', 'cobros/casas', 'cobros/historial']},
    {k:'pagos', txt:'Pagos registrados', desc:'Lista de recibos y formas de pago.', rutas:['cobros/pagos']},
    {k:'cortes', txt:'Cortes de agua', desc:'Casas para notificar, avisos y cortes.', rutas:['cobros/cortes']},
    {k:'tarifas', txt:'Tarifas', desc:'Ver y cambiar cuánto se cobra.', rutas:['cobros/tarifas']},
    {k:'solicitudes', txt:'Solicitudes de registro', desc:'Personas que piden una cuenta.', rutas:['usuarios/solicitudes']},
    {k:'vecinos', txt:'Lista de vecinos', desc:'Cuentas de los representantes de las casas.', rutas:['usuarios/vecinos']},
    {k:'administradores', txt:'Lista de administradores', desc:'Quiénes forman la junta y el personal.', rutas:['usuarios/administradores']},
    {k:'configuracion', txt:'Configuración', desc:'Datos generales, contacto, política de privacidad y copias.', rutas:['configuracion']}
  ]},
  {grupo:'Acciones que puede realizar', items:[
    {k:'crear_incidencias', txt:'Registrar y resolver incidencias', desc:'Reportar, resolver y reabrir incidencias.',
      sel:'#incNueva, #incFormBox, [data-resolver], [data-resolver-id], [data-reabrir-id]'},
    {k:'responder_reportes', txt:'Responder reportes', desc:'Cambiar el estado y responder a los vecinos.', sel:'[data-guardar-rep], .reporte .respuesta'},
    {k:'operar_red', txt:'Operar la red', desc:'Abrir o cerrar llaves y marcar sectores con o sin agua.',
      sel:'.p-estado .interruptor, .p-estado [data-estado], .interruptor-flujo'},
    {k:'editar_casas', txt:'Editar datos de las casas', desc:'Representante, teléfono, núcleos familiares, tarifa y cobro.',
      sel:'#fdGuardar, .fc-corregir, #nGuardar, #nAgregar, [data-quitar-n]'},
    {k:'registrar_pagos', txt:'Registrar pagos y cargos', desc:'Registrar pagos, cargos extra y el cargo de reconexión.',
      sel:'#crRegistrar, [data-fc-tab="pago"], #pPagar, #fcExtraBtn, #fcExtra, [data-ir-tab="pago"], [data-accion-pago]'},
    {k:'anular', txt:'Anular pagos y cargos', desc:'Anular movimientos con un motivo.', sel:'.libreta [data-anular]'},
    {k:'arreglos', txt:'Arreglos de pago', desc:'Crear, cumplir o cancelar arreglos de pago.', sel:'#arrNuevoBtn, #arrForm, [data-arreglo]'},
    {k:'acciones_corte', txt:'Cortes de agua', desc:'Notificar, cortar, reincorporar y cambiar las reglas.',
      sel:'[data-notificar], [data-cortar], [data-anular-aviso], [data-reincorporar], .corte-caja .rango, #ctReglas'},
    {k:'aprobar', txt:'Aprobar solicitudes', desc:'Aprobar o rechazar a quienes piden una cuenta.', sel:'[data-aprobar], [data-rechazar], .modo-acceso, .solicitud .campo'},
    {k:'editar_mapa', txt:'Editar el mapa', desc:'Agregar, mover, cambiar o eliminar casas, tuberías, llaves, sectores y conectores. Empieza desactivado.',
      opcional:true, sel:'#btnEditarMapa, #edicionActiva'},
    {k:'gestionar_vecinos', txt:'Gestionar cuentas de vecinos', desc:'Vincular casas, suspender, eliminar o agregar vecinos.',
      sel:'[data-suspender], [data-reactivar], [data-eliminar-cuenta], [data-agregar-casa], [data-quitar-casa], [data-hacer-admin], .invitar, #fdVincular'}
  ]}
];
const TODOS_PERMISOS = PERMISOS.flatMap(g => g.items);
const PLANTILLAS_PERMISOS = {
  todo:{txt:'Todo (incluye editar el mapa)', claves:TODOS_PERMISOS.map(p => p.k)},
  tesoreria:{txt:'Tesorería', claves:['resumen', 'cobros', 'pagos', 'cortes', 'tarifas', 'vecinos', 'registrar_pagos', 'anular', 'arreglos', 'acciones_corte']},
  operacion:{txt:'Operación de la red', claves:['mapa', 'incidencias', 'reportes', 'sectores', 'resumen', 'crear_incidencias', 'responder_reportes', 'operar_red']},
  secretaria:{txt:'Secretaría', claves:['solicitudes', 'vecinos', 'administradores', 'reportes', 'cobros', 'resumen', 'aprobar', 'gestionar_vecinos', 'responder_reportes', 'editar_casas']},
  lectura:{txt:'Solo mirar', claves:PERMISOS[0].items.map(p => p.k)}
};
/* Los permisos marcados como «opcional» (editar el mapa) empiezan desactivados */
const tienePermiso = k => {
  if (esDev()) return true;
  const p = (miPerfil && miPerfil.permisos) || {}, it = TODOS_PERMISOS.find(x => x.k === k);
  return it && it.opcional ? p[k] === true : p[k] !== false;
};
const permisoActivo = (perm, it) => it.opcional ? perm[it.k] === true : perm[it.k] !== false;
function rutaPermitida(ruta){
  if (esDev()) return true;
  const it = PERMISOS[0].items.find(x => x.rutas.includes(ruta));
  return !it || tienePermiso(it.k);
}
/* Oculta secciones y botones sin permiso (con una hoja de estilos generada) */
function aplicarPermisos(){
  let hoja = document.getElementById('estiloPermisos');
  if (!hoja){ hoja = document.createElement('style'); hoja.id = 'estiloPermisos'; document.head.appendChild(hoja); }
  const reglas = [];
  // Funciones exclusivas del desarrollador: cualquier enlace para dibujar queda oculto
  if (!esDev()) reglas.push('a[href^="#/mapa/dibujar/"]', '[data-solo-dev]');
  TODOS_PERMISOS.forEach(p => {
    if (tienePermiso(p.k)) return;
    (p.rutas || []).forEach(r => reglas.push(`a[href="#/${r}"]`, `a[data-ruta="${r}"]`, `a[href^="#/${r}/"]`));
    if (p.rutas) reglas.push(`[data-seccion="${p.k}"]`);
    if (p.sel) reglas.push(p.sel);
  });
  hoja.textContent = reglas.map(r => r + '{display:none!important}').join('\n');
  // Menús: ocultar opciones y grupos que quedaron vacíos
  document.querySelectorAll('#nav .submenu li').forEach(li => {
    const a = li.querySelector('a[href^="#/"]');
    if (a) li.classList.toggle('sin-permiso', getComputedStyle(a).display === 'none');
  });
  document.querySelectorAll('#nav .grupo[data-grupo]').forEach(g => {
    if (g.dataset.grupo === 'inicio') return;
    const visibles = [...g.querySelectorAll('.submenu a[href^="#/"]')].filter(a => getComputedStyle(a).display !== 'none' && !a.closest('[hidden]'));
    g.classList.toggle('sin-permiso', !visibles.length);
  });
  if (vistaActual && !rutaPermitida(vistaActual)) location.hash = '#/inicio';
}

/* --- Página de permisos (solo desarrollador) --- */
let permElegido = null, permEdicion = null;
function renderPermisos(){
  if (!esDev()){ location.hash = '#/inicio'; return; }
  const admins = adminsLista.filter(a => a.rol === 'administrador');
  const cont = $('#permLista');
  if (!admins.length){
    cont.innerHTML = '<div class="vacio-grande">Todavía no hay administradores. Nómbralos desde <a href="#/usuarios/administradores">Administradores</a>.</div>';
    $('#permPanel').innerHTML = ''; return;
  }
  if (!permElegido || !admins.some(a => a.id === permElegido)) permElegido = admins[0].id;
  const perfilDe = id => perfilesLista.find(p => p.id === id) || admins.find(p => p.id === id) || {};
  const negados = id => Object.entries(perfilDe(id).permisos || {}).filter(([, v]) => v === false).length;
  cont.innerHTML = admins.map(a => `<button class="perm-admin ${a.id === permElegido ? 'on' : ''}" data-perm-admin="${esc(a.id)}">
      <span class="ini" aria-hidden="true">${esc((a.nombre || '?').trim().charAt(0).toUpperCase())}</span>
      <span class="nom"><b>${esc(a.nombre || 'Sin nombre')}</b><small>${esc(nombreCargo(a) || 'Administrador')}</small></span>
      <span class="pill ${negados(a.id) ? 'warn' : 'ok'}">${negados(a.id) ? negados(a.id) + ' sin permiso' : 'Todo'}</span></button>`).join('');
  cont.querySelectorAll('[data-perm-admin]').forEach(b => b.addEventListener('click', () => { permElegido = b.dataset.permAdmin; permEdicion = null; renderPermisos(); }));
  const p = perfilDe(permElegido);
  if (!permEdicion || permEdicion.id !== permElegido) permEdicion = {id:permElegido, permisos:{...(p.permisos || {})}};
  const perm = permEdicion.permisos;
  $('#permPanel').innerHTML = `
    <header class="perm-cab"><div><h2>${esc(p.nombre || 'Administrador')}</h2><p class="nota">${esc(nombreCargo(p) || 'Administrador')}</p></div>
      <div class="fila"><label class="campo compacto"><span>Plantilla</span><select id="permPlantilla"><option value="">Elegir…</option>
        ${Object.entries(PLANTILLAS_PERMISOS).map(([k, v]) => `<option value="${k}">${v.txt}</option>`).join('')}</select></label></div></header>
    ${PERMISOS.map(g => `<section class="perm-grupo"><h3>${g.grupo}</h3>${g.items.map(it => `
      <label class="perm-item"><span class="txt"><b>${esc(it.txt)}</b><small>${esc(it.desc)}</small></span>
        <span class="interruptor"><input type="checkbox" data-perm="${it.k}" ${permisoActivo(perm, it) ? 'checked' : ''}><span class="riel"></span></span></label>`).join('')}</section>`).join('')}
    <div class="fila perm-acciones">
      <button class="btn primario" id="permGuardar">Guardar permisos</button>
      <button class="btn" id="permTodos">Aplicar a todos los administradores</button>
    </div>
    <p class="nota">Lo que desactives desaparece de la pantalla de ${esc((p.nombre || 'este administrador').split(' ')[0])} en cuanto guardes, y la base de datos también le impide hacer esas acciones. El Inicio siempre lo puede ver.</p>`;
  $('#permPanel').querySelectorAll('[data-perm]').forEach(c => c.addEventListener('change', () => {
    const it = TODOS_PERMISOS.find(x => x.k === c.dataset.perm);
    if (it.opcional){ if (c.checked) perm[it.k] = true; else delete perm[it.k]; }
    else { if (c.checked) delete perm[it.k]; else perm[it.k] = false; }
  }));
  $('#permPlantilla').addEventListener('change', e => {
    const pl = PLANTILLAS_PERMISOS[e.target.value]; if (!pl) return;
    permEdicion.permisos = Object.fromEntries(TODOS_PERMISOS.map(x => [x.k, pl.claves.includes(x.k) ? (x.opcional ? true : null) : (x.opcional ? null : false)]).filter(([, v]) => v !== null));
    renderPermisos();
    aviso(`Plantilla «${pl.txt}» aplicada. Revisa y pulsa «Guardar permisos».`);
  });
  const guardar = async ids => {
    const permisos = Object.fromEntries(Object.entries(permEdicion.permisos).filter(([, v]) => v === false || v === true));
    for (const id of ids){
      const ok = await tarea(sb.from('perfiles').update({permisos}).eq('id', id), 'No se pudieron guardar los permisos');
      if (!ok) return;
      const pp = perfilesLista.find(x => x.id === id); if (pp) pp.permisos = {...permisos};
      const aa = adminsLista.find(x => x.id === id); if (aa) aa.permisos = {...permisos};
    }
    aviso(ids.length > 1 ? `Permisos aplicados a ${ids.length} administradores.` : 'Permisos guardados.');
    renderPermisos();
  };
  $('#permGuardar').addEventListener('click', () => guardar([permElegido]));
  $('#permTodos').addEventListener('click', () => {
    if (confirm(`¿Dar estos mismos permisos a los ${admins.length} administradores?`)) guardar(admins.map(a => a.id));
  });
}

/* =====================================================================
   EDITAR MAPA: los cambios del mapa quedan pendientes hasta "Guardar".
   "Cancelar" vuelve todo como estaba. Fuera de este modo el mapa no se modifica
   (salvo lo operativo: abrir o cerrar llaves, agua de sectores, datos de casas).
   ===================================================================== */
const CONTROLES_GEOMAN = {position:'topleft', drawMarker:false, drawCircle:false, drawText:false, drawCircleMarker:true,
  drawPolyline:true, drawRectangle:true, drawPolygon:true, cutPolygon:false, rotateMode:false};
let edicion = null;                    // {foto: Map(id → fila), borrados: Set}
const enEdicion = () => !!edicion;
const puedeEditarMapa = () => tienePermiso('editar_mapa');
function entrarEdicion(){
  if (!puedeEditarMapa()){ aviso('No tienes permiso para editar el mapa.'); return false; }
  if (edicion) return true;
  asegurarMapa();
  flush(true);
  edicion = {foto:new Map([...capas].map(([id, l]) => [id, JSON.parse(JSON.stringify(fila(l)))])), borrados:new Set()};
  try { map.pm.addControls(CONTROLES_GEOMAN); } catch (e){}
  document.body.classList.add('mapa-en-edicion');
  pintarEdicion();
  if (selected) renderPanel();
  aviso('Modo edición: los cambios se guardan cuando pulses «Guardar».', 5000);
  return true;
}
function salirEdicion(){
  edicion = null;
  try { map.pm.disableDraw(); map.pm.removeControls(); } catch (e){}
  pendingTipo = null; trazado = null; marcarBotones();
  document.body.classList.remove('mapa-en-edicion');
  $('#menuAnadir').hidden = true;
  actualizarAsaGiro();
  pintarEdicion();
  if (selected) renderPanel();
}
function cambiosEdicion(){ return edicion ? pendientes.size + edicion.borrados.size : 0; }
function pintarEdicion(){
  const ed = enEdicion();
  $('#btnEditarMapa').hidden = ed || !puedeEditarMapa();
  $('#edicionActiva').hidden = !ed;
  const n = cambiosEdicion();
  $('#edCambios').textContent = n ? `${n} ${n === 1 ? 'cambio sin guardar' : 'cambios sin guardar'}` : 'Sin cambios';
  $('#edCambios').classList.toggle('hay', !!n);
}
async function guardarEdicion(){
  if (!edicion) return;
  terminarEdicion(); map.pm.disableDraw();
  const n = cambiosEdicion();
  $('#btnGuardarEd').disabled = true;
  await flush(true);
  if (pendientes.size){ $('#btnGuardarEd').disabled = false; aviso('No se pudieron guardar todos los cambios. Revisa la conexión e inténtalo de nuevo.', 7000); return; }
  for (const id of [...edicion.borrados]){
    if (!await tarea(sb.from('formas').delete().eq('id', id), 'No se pudo eliminar una forma')){ $('#btnGuardarEd').disabled = false; return; }
    edicion.borrados.delete(id);
  }
  $('#btnGuardarEd').disabled = false;
  salirEdicion();
  aviso(n ? `Mapa guardado (${n} ${n === 1 ? 'cambio' : 'cambios'}).` : 'No había cambios que guardar.');
  recalcularIncidencias();
}
function cancelarEdicion(){
  if (!edicion) return;
  const n = cambiosEdicion();
  if (n && !confirm(`¿Descartar ${n} ${n === 1 ? 'cambio' : 'cambios'} sin guardar? El mapa volverá a como estaba.`)) return;
  terminarEdicion(); map.pm.disableDraw(); cerrarPanel();
  const foto = edicion.foto;
  pendientes.clear();
  [...capas.keys()].forEach(id => { if (!foto.has(id)) quitarCapaLocal(capas.get(id)); });
  foto.forEach(f => {
    const l = capas.get(f.id);
    if (!l || JSON.stringify(fila(l)) !== JSON.stringify(f)) aplicarFilaForma(f);
  });
  salirEdicion();
  geometriaCambio(); recalcularIncidencias();
  aviso(n ? 'Cambios descartados: el mapa volvió a como estaba.' : 'Edición cerrada.');
}
/* Pide estar en modo edición (si la persona puede, entra sola) */
function requiereEdicion(){
  if (!puedeEditarMapa()){ aviso('No tienes permiso para editar el mapa.', 5000); return false; }
  return enEdicion() || entrarEdicion();
}
$('#btnEditarMapa').addEventListener('click', entrarEdicion);
$('#btnGuardarEd').addEventListener('click', guardarEdicion);
$('#btnCancelarEd').addEventListener('click', cancelarEdicion);
$('#btnAnadir').addEventListener('click', e => {
  e.stopPropagation();
  const ab = $('#menuAnadir').hidden; $('#menuAnadir').hidden = !ab; $('#btnAnadir').setAttribute('aria-expanded', String(ab));
});
document.addEventListener('click', e => { if (!e.target.closest('.menu-anadir')) $('#menuAnadir').hidden = true; });
$('#menuAnadir').addEventListener('click', e => { if (e.target.closest('[data-dibujar]')) $('#menuAnadir').hidden = true; });
window.addEventListener('beforeunload', e => { if (cambiosEdicion()){ e.preventDefault(); e.returnValue = ''; } });

/* =====================================================================
   CATEGORÍAS DE CASAS: color en el mapa y tarifa de cada una
   ===================================================================== */
let categorias = [];
const categoriaDe = d => categorias.find(c => c.id === ((d && d.categoria) || 'casa')) || categorias.find(c => c.id === 'casa') || null;
async function cargarCategorias(){
  const {data, error} = await sb.from('categorias_casa').select('*').order('orden').order('nombre');
  if (error) return;
  categorias = data || [];
  if (typeof capa !== 'undefined') capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'casa') aplicarEstilo(l); });
  if (/cobros\/tarifas/.test(vistaActual || '')) renderCobTarifas();
  if (selected && selected.aq.tipo === 'casa') renderPanel();
}
const opcionesCategoria = sel => categorias.map(c => `<option value="${esc(c.id)}" ${c.id === (sel || 'casa') ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')
  + (tienePermiso('tarifas') ? '<option value="__nueva">＋ Nueva categoría…</option>' : '');
/* Ventana "Nueva categoría" (desde el panel de la casa o desde Tarifas) */
let alCrearCategoria = null;
function abrirNuevaCategoria(despues){
  alCrearCategoria = despues || null;
  const f = $('#formCategoria'); f.reset(); f.color.value = '#8E44AD';
  $('#catTarifa').innerHTML = '<option value="__propia">Crear una tarifa propia para esta categoría</option>'
    + tarifas.map(t => `<option value="${esc(t.id)}">Usar: ${esc(t.nombre)} (${esc(dinero(t.monto))})</option>`).join('');
  pintarMuestraCat();
  $('#catNuevaTarifa').hidden = false;
  $('#dlgCategoria').showModal();
  setTimeout(() => f.nombre.focus(), 0);
}
function pintarMuestraCat(){ const f = $('#formCategoria'); $('#catMuestra').style.background = f.color.value; $('#catMuestra').textContent = f.nombre.value || 'Así se verá'; }
$('#formCategoria').color.addEventListener('input', pintarMuestraCat);
$('#formCategoria').nombre.addEventListener('input', pintarMuestraCat);
$('#catTarifa').addEventListener('change', () => { $('#catNuevaTarifa').hidden = $('#catTarifa').value !== '__propia'; });
$('#formCategoria').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, nombre = f.nombre.value.trim();
  if (nombre.length < 2){ aviso('Escribe el nombre de la categoría.'); return; }
  const id = nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid();
  if (categorias.some(c => c.id === id)){ aviso('Ya existe una categoría con ese nombre.'); return; }
  let tarifa = f.tarifa.value;
  if (tarifa === '__propia'){
    const tid = 'tarifa-' + id;
    const t = await consultaConFila(sb.from('tarifas').upsert({id:tid, nombre:'Tarifa ' + nombre, monto:round2(f.monto.value), modo:f.modo.value, orden:tarifas.length + 1}).select().single(), 'No se pudo crear la tarifa');
    if (!t) return;
    if (!tarifas.some(x => x.id === t.id)) tarifas.push(t);
    tarifa = t.id;
  }
  const c = await consultaConFila(sb.from('categorias_casa').insert({id, nombre, color:f.color.value, tarifa_id:tarifa, orden:categorias.length + 1}).select().single(), 'No se pudo crear la categoría');
  if (!c) return;
  if (!categorias.some(x => x.id === c.id)) categorias.push(c);
  $('#dlgCategoria').close();
  aviso(`Categoría «${nombre}» creada.`);
  if (alCrearCategoria) alCrearCategoria(c.id);
  if (/cobros\/tarifas/.test(vistaActual || '')) renderCobTarifas();
});
{ const dl = $('#dlgCategoria'); dl.querySelectorAll('[data-cerrar]').forEach(x => x.addEventListener('click', () => dl.close())); dl.addEventListener('click', e => { if (e.target === dl) dl.close(); }); }
document.addEventListener('click', e => { if (e.target.closest('[data-nueva-categoria]')) abrirNuevaCategoria(); });
/* Lista de categorías en Tarifas */
function renderCategorias(){
  const cont = $('#catLista'); if (!cont) return;
  const casas = datosGenerales().casas;
  cont.innerHTML = categorias.map(c => {
    const n = casas.filter(l => (l.aq.datos.categoria || 'casa') === c.id).length;
    return `<div class="cat-fila" data-cat="${esc(c.id)}">
      <input type="color" value="${esc(c.color)}" data-cat-color aria-label="Color de ${esc(c.nombre)}">
      <b>${esc(c.nombre)}<small>${n} ${n === 1 ? 'casa' : 'casas'}${c.predefinida ? ' · predefinida' : ''}</small></b>
      <select data-cat-tarifa aria-label="Tarifa de ${esc(c.nombre)}">${tarifas.map(t => `<option value="${esc(t.id)}" ${t.id === c.tarifa_id ? 'selected' : ''}>${esc(t.nombre)} · ${esc(dinero(t.monto))}</option>`).join('')}</select>
      <span class="acc">${c.predefinida ? '' : '<button class="btn chico peligro" data-cat-borrar>Quitar</button>'}</span><span></span></div>`;
  }).join('') || '<p class="vacio">No hay categorías.</p>';
  cont.querySelectorAll('[data-cat]').forEach(fila => {
    const id = fila.dataset.cat, c = categorias.find(x => x.id === id);
    fila.querySelector('[data-cat-color]').addEventListener('change', async e => {
      if (await tarea(sb.from('categorias_casa').update({color:e.target.value}).eq('id', id), 'No se pudo cambiar el color')){ c.color = e.target.value; capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'casa') aplicarEstilo(l); }); aviso('Color actualizado.'); }
    });
    fila.querySelector('[data-cat-tarifa]').addEventListener('change', async e => {
      if (!await tarea(sb.from('categorias_casa').update({tarifa_id:e.target.value}).eq('id', id), 'No se pudo cambiar la tarifa')) return;
      c.tarifa_id = e.target.value;
      aviso(`Las casas de «${c.nombre}» usan ahora esta tarifa desde el próximo mes. Para aplicarla a este mes, usa «Corregir cuotas» en la ficha de cada casa.`, 7000);
      renderCobTarifas();
    });
    const b = fila.querySelector('[data-cat-borrar]');
    if (b) b.addEventListener('click', async () => {
      const usan = casas.filter(l => (l.aq.datos.categoria || 'casa') === id);
      if (!confirm(`¿Quitar la categoría «${c.nombre}»?${usan.length ? ` Sus ${usan.length} casas pasarán a la categoría «Casa».` : ''}`)) return;
      usan.forEach(l => { delete l.aq.datos.categoria; guardarForma(l.aq.id); aplicarEstilo(l); });
      await flush(true);
      if (await tarea(sb.from('categorias_casa').delete().eq('id', id), 'No se pudo quitar la categoría')){ categorias = categorias.filter(x => x.id !== id); renderCobTarifas(); }
    });
  });
}

/* =====================================================================
   CONEXIÓN DE CASAS: solo confirmada desde «Sacar ramal» (y una sola vez,
   las acometidas que ya existían se convierten en conexiones confirmadas)
   ===================================================================== */
async function convertirConexionesAntiguas(){
  if (state.settings.casasEnlazadas || !puedeEditarMapa()) return;
  let n = 0;
  capas.forEach(l => {
    if (!l.aq || l.aq.tipo !== 'tuberia' || !esLinea(l)) return;
    const d = l.aq.datos; if (d.casaOrigen || d.casaDestino) return;
    const pts = puntosDe(l), ini = casaEn(pts[0], null), fin = casaEn(pts[pts.length - 1], ini ? ini.aq.id : null);
    if (fin){ d.casaDestino = fin.aq.id; }
    if (ini && (fin || d.clase === 'acometida')){ d.casaOrigen = ini.aq.id; }
    if (d.casaOrigen || d.casaDestino){ guardarForma(l.aq.id); n++; }
  });
  if (n) await flush(true);
  if (await tarea(sb.from('configuracion').update({casas_enlazadas:true, editado_por:CLIENTE_ID}).eq('id', 1), '')){
    state.settings.casasEnlazadas = true;
    if (n){ geometriaCambio(); aviso(`Se confirmaron ${n} ${n === 1 ? 'conexión' : 'conexiones'} de casas que ya estaban dibujadas.`, 6000); }
  }
}

/* =====================================================================
   LLAVES CERRADAS: sin agua lo que está después, según el efecto elegido
   ===================================================================== */
map.createPane('cierres').style.zIndex = 445;      // por encima de tuberías y casas, debajo de las incidencias
const capaCierres = L.layerGroup().addTo(map);
let efectosLlaves = [];
const EFECTOS_CIERRE = {casas:'Solo las casas', sector:'Solo el sector', ambos:'Casas y sector'};
const ESTILO_CIERRE = {
  tubo:{pane:'cierres', color:'#D32F2F', weight:7, opacity:.95, lineCap:'round', className:'con-incidencia'},
  casa:{pane:'cierres', color:'#B71C1C', weight:2.5, fillColor:'#E53935', fillOpacity:.7, className:'con-incidencia'},
  sector:{pane:'cierres', color:'#C62828', weight:2.5, dashArray:'8 6', fillColor:'#E53935', fillOpacity:.28}
};
let sectoresCerrados = new Set();
function calcularCierres(){
  // Los sectores que estaban sin agua por una llave recuperan su etiqueta normal
  sectoresCerrados.forEach(id => { const l = capas.get(id); if (l) actualizarTooltip(l); });
  sectoresCerrados = new Set();
  capaCierres.clearLayers(); efectosLlaves = [];
  const rd = redActual();
  capas.forEach(l => {
    if (!l.aq || l.aq.tipo !== 'llave' || l.aq.datos.estado !== 'cerrada') return;
    const efecto = l.aq.datos.efectoCierre || 'ambos';
    const r = Acu.efectoLlave(rd, l.aq.id, efecto);
    efectosLlaves.push({id:l.aq.id, efecto, r});
    // En rojo: las tuberías desde la llave en adelante y, según lo elegido, las casas y/o el sector
    r.piezas.forEach(p => L.polyline(p.latlngs, {...ESTILO_CIERRE.tubo, interactive:false}).addTo(capaCierres));
    // Tuberías enteras sin agua (las piezas solo traen los tramos parciales)
    r.formas.forEach(id => { const t = capas.get(id); if (t && t.aq.tipo === 'tuberia' && esLinea(t))
      L.polyline(t.getLatLngs(), {...ESTILO_CIERRE.tubo, weight:Math.max(6, Acu.grosorTuberia(t.aq.datos) + 2), interactive:false}).addTo(capaCierres); });
    r.casas.forEach(id => { const c = capas.get(id); if (!c) return;
      (esPunto(c) ? L.circleMarker(c.getLatLng(), {radius:10, ...ESTILO_CIERRE.casa, interactive:false})
        : L.polygon(c.getLatLngs(), {...ESTILO_CIERRE.casa, interactive:false})).addTo(capaCierres); });
    r.sectores.forEach(id => { const s = capas.get(id); if (!s || !esPoligono(s)) return;
      L.polygon(s.getLatLngs(), {...ESTILO_CIERRE.sector, interactive:false}).addTo(capaCierres);
      sectoresCerrados.add(id);
      Acu.ponerEtiquetaSector(s, {...s.aq.datos, activo:false}, 'Llave cerrada' + (l.aq.datos.nombre ? ': ' + l.aq.datos.nombre : '')); });
  });
}
/* Publica qué casas y sectores están afectados (lo usa la página de vecinos aunque la red esté oculta) */
let ultimosEfectos = '';
const publicarEfectos = debounce(async () => {
  if (!sb || enEdicion() || !miPerfil) return;
  const filas = [];
  incAbiertas().filter(i => i.publica !== false).forEach(inc => {
    const r = afectacionDe(inc);
    filas.push({id:'incidencia:' + inc.id, tipo:'incidencia', ref:inc.id, etiqueta:inc.tipo, casas:[...r.casas].sort(), sectores:[...r.sectores].sort()});
  });
  efectosLlaves.forEach(x => {
    const l = capas.get(x.id);
    filas.push({id:'llave:' + x.id, tipo:'llave', ref:x.id, etiqueta:l ? titulo(l.aq) : 'Llave cerrada', casas:[...x.r.casas].sort(), sectores:[...x.r.sectores].sort()});
  });
  const firma = JSON.stringify(filas);
  if (firma === ultimosEfectos) return;
  const {data:actuales, error} = await sb.from('efectos_publicos').select('id');
  if (error) return;
  const ids = new Set(filas.map(f => f.id)), borrar = (actuales || []).map(x => x.id).filter(id => !ids.has(id));
  if (filas.length){ const r = await sb.from('efectos_publicos').upsert(filas.map(f => ({...f, updated_at:new Date().toISOString()}))); if (r.error) return; }
  if (borrar.length) await sb.from('efectos_publicos').delete().in('id', borrar);
  ultimosEfectos = firma;
}, 1500);

/* =====================================================================
   PERMISOS: solo el desarrollador crea, borra o edita las formas del mapa
   ===================================================================== */
function aplicarPermisosFormas(){
  const dev = esDev();
  document.querySelectorAll('[data-solo-dev]').forEach(e => { e.hidden = !dev; });
  if (!enEdicion()){ try { map.pm.removeControls(); map.pm.disableDraw(); } catch (e){} }
  pintarEdicion();
}
function soloDev(accion){
  if (esDev()) return true;
  aviso('Solo el desarrollador puede ' + (accion || 'crear o editar las formas del mapa') + '.', 5000);
  return false;
}

/* =====================================================================
   PANEL DE DETALLES
   Barra de acciones rápidas, recuadro de estado, pestañas y "Más opciones".
   ===================================================================== */
const tabActivo = {};                     // pestaña elegida por tipo de forma
const NOMBRE_TAB = {datos:'Datos', agua:'Agua', cuotas:'Cobros', inc:'Incidencias'};
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
  const dev = enEdicion();          // las acciones de edición solo en «Editar mapa»
  let conexionTubo = '';
  let acciones = accion('pCentrar', '◎', 'Centrar');
  if (dev) acciones += accion('pEditar', editandoEsta ? '✓' : '✥',
    editandoEsta ? 'Listo' : (esPunto(layer) ? 'Mover' : 'Mover puntos'), editandoEsta ? 'class="p-acc on"' : '');
  if (dev && aq.tipo === 'tuberia') acciones += accion('pRamal', '⑂', 'Sacar ramal');


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
      ${r.tubos.size ? '' : '<p class="nota">Para conectarla, selecciona la tubería, pulsa «Sacar ramal» y termina el trazo en esta casa.</p>'}
      <p>💵 Cuenta: <span class="pill ${est.cls}">${esc(est.txt)}</span></p>
      <div class="fila">${r.tubos.size ? '<button class="btn chico" id="verRed">Resaltar lo conectado</button>' : ''}
      </div></div>`;
  } else if (aq.tipo === 'sector'){
    estado = `<div class="p-estado">
      <label class="interruptor grande"><input type="checkbox" id="secFlujo" ${d.activo ? 'checked' : ''}><span class="riel"></span><span>${d.activo ? 'Con agua ahora' : 'Sin agua ahora'}</span></label>
      <p class="nota">${esc(d.activoDesde ? (d.activo ? 'Con agua ' : 'Sin agua ') + Acu.desde(d.activoDesde) + '.' : 'Aún no se ha cambiado el estado.')} Se ve en vivo en la página pública.</p></div>`;
  } else if (aq.tipo === 'llave'){
    const ef = d.efectoCierre || 'ambos', x = efectosLlaves.find(e => e.id === aq.id);
    const tubos = redConectada(aq.id);
    estado = `<div class="p-estado ${d.estado === 'cerrada' ? 'aviso' : ''}">
      ${tubos.tubos.size ? '' : '<p>⚠ Esta llave no está sobre ninguna tubería. Colócala encima de una línea para que controle el agua.</p>'}
      <div class="segmento" role="group" aria-label="Estado de la llave">
        <button data-estado="abierta" class="${d.estado !== 'cerrada' ? 'on' : ''}">💧 Abrir</button>
        <button data-estado="cerrada" class="${d.estado === 'cerrada' ? 'on' : ''}">⛔ Cerrar</button></div>
      <label class="campo efecto-cierre"><span>Al cerrarla, marcar sin agua</span></label>
      <div class="segmento" role="group" aria-label="Efecto del cierre">${Object.entries(EFECTOS_CIERRE).map(([k, v]) =>
        `<button data-efecto="${k}" class="${k === ef ? 'on' : ''}">${v}</button>`).join('')}</div>
      ${d.estado === 'cerrada' && x ? `<p class="resumen-cierre">⛔ Sin agua: <b>${x.r.casas.size}</b> ${x.r.casas.size === 1 ? 'casa' : 'casas'}${x.r.sectores.size ? ', sectores: ' + esc([...x.r.sectores].map(id => { const l = capas.get(id); return l ? titulo(l.aq) : ''; }).filter(Boolean).join(', ')) : ''} y ${x.r.tubos.size} ${x.r.tubos.size === 1 ? 'tubería' : 'tuberías'} sin flujo.</p>` : ''}
      <p class="nota">El agua se corta desde la llave en la dirección del flujo. Revisa que las tuberías tengan su dirección del agua definida.</p></div>`;
  } else if (aq.tipo === 'conector'){
    const con = conexionesConector(layer), roles = Acu.rolesConector(d), forma = Acu.formaDe(d);
    const sinRoles = roles.every(r => !r), tam = Array.isArray(d.tamanos) ? d.tamanos : [];
    const fila = i => {
      const t = con[i], rol = roles[i];
      return `<li class="${rol === 'entrada' ? 'es-entrada' : ''}"><span class="puerto ${rol === 'entrada' ? 'ent' : ''}">${i + 1}</span>
        <span class="nom">Punta ${i + 1} <small class="lado">${esc(forma.brazos[i] || '')}${d.forma === 'buje' && tam[i] ? ' · ' + esc(tam[i]) + '"' : ''}</small>
          <small>${rol === 'entrada' ? '💧 Entrada · ' : rol === 'salida' ? 'Salida · ' : 'Libre · '}${t ? esc(titulo(t.layer.aq)) : 'sin tubería'}</small></span>
        <span class="botones">
          ${dev ? `<span class="roles-punta" role="group" aria-label="Rol de la punta ${i + 1}">
            <button class="entrada ${rol === 'entrada' ? 'on' : ''}" data-rol="${i}:entrada" title="El agua entra por esta punta">E</button>
            <button class="salida ${rol === 'salida' ? 'on' : ''}" data-rol="${i}:salida" title="El agua sale por esta punta">S</button>
            <button class="libre ${!rol ? 'on' : ''}" data-rol="${i}:" title="Sin definir: pasa en cualquier sentido">–</button></span>` : ''}
          ${t ? `<button class="btn chico" data-ir="${esc(t.layer.aq.id)}">Ver</button>` : dev ? `<button class="btn chico" data-desde-puerto="${i}">Conectar</button>` : ''}</span></li>`;
    };
    estado = `<div class="p-estado ${sinRoles ? 'aviso' : ''}">
      <p>${sinRoles ? '⚠ <b>Todas las puntas están libres.</b> Asigna con <b>E</b> la entrada y con <b>S</b> las salidas para controlar el flujo del agua.'
                     : `💧 Entrada por ${roles.map((r, i) => r === 'entrada' ? i + 1 : null).filter(Boolean).join(', ') || '—'} · salida por ${roles.map((r, i) => r === 'salida' ? i + 1 : null).filter(Boolean).join(', ') || '—'}.`}</p>
      <ul class="puertos">${roles.map((_, i) => fila(i)).join('')}</ul>
      <p class="nota">En el mapa, cada punta muestra su número; «E» es entrada y «S» salida. Las puntas libres dejan pasar el agua en cualquier sentido.</p></div>`;
  } else {
    estado = `<div class="p-estado aviso"><p>Esta forma todavía no tiene función. Elige qué es:</p>${botonesTipo(layer)}</div>`;
  }

  /* --- Pestañas --- */
  const pestañas = {};
  if (aq.tipo === 'casa'){
    const cat = categoriaDe(d), b = esPoligono(layer) ? layer.getBounds() : null;
    const med = d.rectangulo && b && !(layer instanceof L.Rectangle) ? medidasRect(layer) : null;
    const ancho = med ? Math.round(med.ancho * 10) / 10 : b ? Math.round(b.getSouthWest().distanceTo(b.getSouthEast()) * 10) / 10 : 0;
    const largo = med ? Math.round(med.alto * 10) / 10 : b ? Math.round(b.getSouthWest().distanceTo(b.getNorthWest()) * 10) / 10 : 0;
    pestañas.datos = `
      <label class="campo"><span>Categoría</span><span class="color-fila"><i class="cat-punto" style="background:${esc(cat ? cat.color : '#3B6EA8')}"></i>
        <select id="pCategoria">${opcionesCategoria(d.categoria)}</select></span></label>
      ${dev && d.cuadrado ? `<label class="campo"><span>Lado (m)</span><input type="number" id="pLado" min="1" max="200" step="0.5" value="${ancho}"></label>
        <p class="nota" style="margin-top:-4px">Casa cuadrada: siempre conserva los cuatro lados iguales.</p>` : ''}
      ${dev && d.rectangulo && !d.cuadrado ? `<div class="dos"><label class="campo"><span>Ancho (m)</span><input type="number" id="pAncho" min="1" max="200" step="0.5" value="${ancho}"></label>
        <label class="campo"><span>Largo (m)</span><input type="number" id="pLargo" min="1" max="200" step="0.5" value="${largo}"></label></div>
        <p class="nota" style="margin-top:-4px">También puedes agrandarla desde sus esquinas con «Mover puntos».</p>` : ''}
      <div class="dos">${campo('Número de casa','numero',d.numero)}${campo('Teléfono','telefono',d.telefono,'tel')}</div>
      ${campo('Representante legal de la casa','responsable',d.responsable)}
      <div class="resumen-nucleos"><span>👪 <b>${nucleosDe(d)}</b> ${nucleosDe(d) === 1 ? 'núcleo familiar' : 'núcleos familiares'} · <b>${personasDe(d)}</b> ${personasDe(d) === 1 ? 'persona' : 'personas'}</span>
        <button class="btn chico" id="pNucleos">Ver y editar</button></div>
      ${areaNotas(d.notas)}`;
    pestañas.cuotas = `
      <div class="cuenta" id="cuentaBox"></div>
      <div class="fila"><button class="btn primario" id="pPagar">Registrar pago</button><button class="btn" id="pFicha">Abrir ficha de cobros</button></div>
      <p class="nota">En la ficha verás el estado de cuenta completo, los núcleos familiares, la tarifa y los recibos.</p>`;
  } else if (aq.tipo === 'tuberia'){
    const m = longitud(layer), materiales = ['PVC','PEAD / polietileno','Hierro galvanizado','Otro'];
    const casaO = d.casaOrigen && capas.get(d.casaOrigen), casaD = d.casaDestino && capas.get(d.casaDestino);
    conexionTubo = (casaO || casaD) ? `<div class="conexion-casa">🏠 ${casaO ? 'Sale de <b>' + esc(titulo(casaO.aq)) + '</b>' : ''}${casaO && casaD ? ' y ' : ''}${casaD ? 'Lleva agua a <b>' + esc(titulo(casaD.aq)) + '</b>' : ''}
      ${dev ? '<button class="btn chico" id="pDesconectarCasa">Desconectar</button>' : ''}</div>` : '';
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
    const DIAMETROS = ['1/2', '3/4', '1', '1 1/4', '1 1/2', '2', '2 1/2', '3', '4', '6'];
    const tamB = Array.isArray(d.tamanos) ? d.tamanos : ['', ''];
    const selDiam = (i) => `<select data-tamano="${i}">${DIAMETROS.map(x => `<option value="${x}" ${x === tamB[i] ? 'selected' : ''}>${x}"</option>`).join('')}</select>`;
    pestañas.datos = `
      <label class="campo"><span>Tipo de conector</span><select id="conForma">
        ${Object.entries(Acu.FORMAS_CONECTOR).map(([k, f]) => `<option value="${k}" ${k === (d.forma || 'T') ? 'selected' : ''}>${k === 'T' || k === 'Y' ? 'Unión en ' + f.nombre : f.nombre} (${f.locales(1, 1).length} puntas)</option>`).join('')}
      </select></label>
      ${d.forma === 'buje' ? `<div class="dos"><label class="campo"><span>Diámetro punta 1</span>${selDiam(0)}</label><label class="campo"><span>Diámetro punta 2</span>${selDiam(1)}</label></div>
        <p class="nota">La tubería unida a cada punta toma ese diámetro y se dibuja más gruesa o más delgada.</p>` : ''}
      <label class="campo"><span>Orientación: <output id="rotVal">${rot}°</output></span>
        <input type="range" id="rotRange" min="0" max="359" step="1" value="${rot}"></label>
      <div class="fila">
        <button class="btn chico" data-girar="15">↺ 15°</button><button class="btn chico" data-girar="-15">↻ 15°</button>
        <button class="btn chico" data-girar="180">Girar 180°</button>
        ${d.forma === 'T' || d.forma === 'codo' || !d.forma ? '<button class="btn chico" id="conEspejo">Cambiar lado del brazo lateral</button>' : ''}</div>
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
  cuerpo.innerHTML = `<div class="p-barra">${acciones}</div>${estado}${controlesGiro(layer)}${conexionTubo}${barraTabs}${cuerpoTabs}${dev ? mas : ''}`;
  enlazarGiro(layer, cuerpo);
  setTimeout(actualizarAsaGiro, 0);
  if ($('#pDesconectarCasa')) $('#pDesconectarCasa').addEventListener('click', () => {
    if (!confirm('¿Quitar la conexión de esta tubería con la casa? La casa dejará de recibir agua por ella.')) return;
    delete aq.datos.casaOrigen; delete aq.datos.casaDestino;
    cambio(); geometriaCambio(); renderPanel();
    aviso('Conexión quitada.');
  });
  enlazarPanel(layer, cuerpo);
  if (!dev && (aq.tipo !== 'casa' || !tienePermiso('editar_casas'))){
    // Solo lectura: los datos se muestran como texto y los botones de edición no aparecen
    cuerpo.querySelectorAll('[data-panel="datos"], [data-panel="agua"]').forEach(p => {
      p.classList.add('solo-lectura');
      p.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
      p.querySelectorAll('button').forEach(el => { el.hidden = true; });
    });
    if (aq.tipo === 'conector') cuerpo.querySelectorAll('.p-estado button').forEach(el => { el.hidden = true; });
  }
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
    cambio(); actualizarTituloPanel();
    recalcularIncidencias(); renderPanel();
    if (aq.tipo === 'llave') aviso(b.dataset.estado === 'cerrada' ? 'Llave cerrada: se marcó sin agua lo que está después.' : 'Llave abierta: el agua vuelve a circular.', 4000);
  }));
  cuerpo.querySelectorAll('[data-efecto]').forEach(b => b.addEventListener('click', () => {
    aq.datos.efectoCierre = b.dataset.efecto;
    cambio(); recalcularIncidencias(); renderPanel();
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
  cuerpo.querySelectorAll('[data-rol]').forEach(b => b.addEventListener('click', () => {
    const [i, rol] = b.dataset.rol.split(':'), roles = Acu.rolesConector(aq.datos);
    roles[Number(i)] = rol || null;
    cambiarConector(layer, {puertos:roles});
    aviso(rol ? `Punta ${Number(i) + 1}: ${rol}. La dirección del agua de la tubería unida se ajustó.` : `Punta ${Number(i) + 1}: libre.`, 4000);
  }));
  if ($('#conForma')) $('#conForma').addEventListener('change', e => {
    const forma = e.target.value, cambios = {forma, puertos:Acu.rolesConector({forma, puertos:[]})};
    if (forma === 'buje' && !Array.isArray(aq.datos.tamanos)) cambios.tamanos = ['3', '2'];
    cambiarConector(layer, cambios);
  });
  cuerpo.querySelectorAll('[data-tamano]').forEach(sel => sel.addEventListener('change', () => {
    const t = Array.isArray(aq.datos.tamanos) ? [...aq.datos.tamanos] : ['', ''];
    t[Number(sel.dataset.tamano)] = sel.value;
    cambiarConector(layer, {tamanos:t});
  }));
  cuerpo.querySelectorAll('[data-desde-puerto]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.desdePuerto), pr = Acu.puertosConector(layer.getLatLng(), aq.datos);
    if (pr.roles[i] === 'entrada') iniciarTrazado('entrada', layer, null);     // hacia la entrada: se termina en la punta
    else iniciarTrazado('salida', layer, pr.todos[i]);                   // desde el brazo: el trazo ya empieza ahí
  }));
  cuerpo.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', () => { const l = capas.get(b.dataset.ir); if (l){ enfocar(l); seleccionar(l); } }));
  if ($('#pEliminar')) $('#pEliminar').addEventListener('click', () => {
    if (!confirm('¿Eliminar esta forma? Se borra para todos, también del mapa público. Su historial de incidencias se conserva.')) return;
    eliminarForma(layer);
    aviso('Forma eliminada.');
  });
  marcarExtremos(layer);
  formIncAbierto = false;
  renderIncidenciasPanel();
  if (aq.tipo === 'casa'){
    $('#pCategoria').addEventListener('change', e => {
      const v = e.target.value;
      const aplicar = id => { aq.datos.categoria = id; cambio(); aplicarEstilo(layer); renderPanel(); refrescarCuenta();
        const c = categoriaDe(aq.datos); aviso(`Categoría: ${c ? c.nombre : id}.`); };
      if (v === '__nueva'){ e.target.value = aq.datos.categoria || 'casa'; abrirNuevaCategoria(aplicar); return; }
      aplicar(v);
    });
    const cambiarTam = () => {
      const a = num($('#pAncho').value), l = num($('#pLargo').value); if (a < 1 || l < 1) return;
      if (!(layer instanceof L.Rectangle)){ const m = medidasRect(layer); layer.setLatLngs(esquinasRect(m.centro, a, l, m.ang)); cambio(); geometriaCambio(); return; }
      const c = layer.getBounds().getCenter(), [mLat, mLng] = metrosPorGrado(c), dLat = l / 2 / mLat, dLng = a / 2 / mLng;
      layer.setBounds([[c.lat - dLat, c.lng - dLng], [c.lat + dLat, c.lng + dLng]]);
      cambio(); geometriaCambio();
    };
    if ($('#pAncho')){ $('#pAncho').addEventListener('change', cambiarTam); $('#pLargo').addEventListener('change', cambiarTam); }
    if ($('#pLado')) $('#pLado').addEventListener('change', () => { const l = num($('#pLado').value); if (l >= 1){ cuadrar(layer, l); cambio(); geometriaCambio(); } });
    refrescarCuenta();
    $('#pPagar').addEventListener('click', () => abrirFicha(aq.id, 'pago'));
    $('#pFicha').addEventListener('click', () => abrirFicha(aq.id, 'cuenta'));
    $('#pNucleos').addEventListener('click', () => abrirFicha(aq.id, 'nucleos'));
  }
}

/* =====================================================================
   MOVER PUNTOS DE UNA FORMA
   ===================================================================== */
let editando = null;
function alternarEdicion(layer){
  if (!requiereEdicion()) return;
  if (editando === layer){ terminarEdicion(); return; }
  terminarEdicion();
  setTimeout(actualizarAsaGiro, 0);
  asegurarMapa();
  editando = layer;
  if (esLinea(layer)) layer.pm._otherSnapLayers = puertosParaUnir();
  layer.pm.enable({snappable:true, snapDistance:18, allowSelfIntersection:true, draggable:esPunto(layer)});
  $('#pista').textContent = esPunto(layer)
    ? 'Arrastra el punto a su nuevo lugar. Pulsa «Listo» al terminar.'
    : layer.aq.datos && layer.aq.datos.cuadrado ? 'Arrastra una esquina para agrandar o achicar la casa: siempre queda cuadrada. Pulsa «Listo» al terminar.'
    : layer.aq.datos && layer.aq.datos.rectangulo ? 'Arrastra una esquina para cambiar el ancho y el largo de la casa. Pulsa «Listo» al terminar.'
    : 'Arrastra los puntos blancos. Toca un punto pequeño intermedio para agregar uno nuevo; clic derecho sobre un punto lo borra. Pulsa «Listo» al terminar.';
  $('#pista').hidden = false;
  if (selected === layer) renderPanel();
}
function terminarEdicion(){
  const layer = editando;
  if (!layer) return;
  editando = null;
  setTimeout(actualizarAsaGiro, 0);
  if (layer.pm && layer.pm.enabled()) layer.pm.disable();
  $('#pista').hidden = !pendingTipo;
  if (layer.aq && layer.aq.tipo === 'tuberia'){
    const msg = ajustarAConectores(layer);
    if (msg) aviso(msg, 5000);
  }
  if (layer.aq){ guardarForma(layer.aq.id); geometriaCambio(); }
  if (selected === layer) renderPanel();
}

function actualizarTituloPanel(){
  if (!selected) return;
  const aq = selected.aq;
  let sub = TIPOS[aq.tipo].nombre;
  if (aq.tipo === 'casa') sub = textoEstado(cuenta(aq)).txt;
  if (aq.tipo === 'sector') sub = aq.datos.activo ? 'Sector con agua' : 'Sector sin agua';
  const inc = textoIncidencias(aq.id);
  if (inc) sub = '⚠ Incidencia: ' + inc;
  $('#pTitulo').innerHTML = `${esc(titulo(aq))}<small${inc ? ' style="color:#C62828;font-weight:700"' : ''}>${esc(sub)}</small>`;
}

function refrescarCuenta(){
  const box = $('#cuentaBox'); if (!box || !selected || selected.aq.tipo !== 'casa') return;
  const aq = selected.aq, c = cuenta(aq), est = textoEstado(c);
  box.innerHTML = `
    <div class="estado"><span>Estado de cuenta</span><span class="pill ${est.cls}">${esc(est.txt)}</span></div>
    ${c.aplica ? `<dl>
      <dt>Cuota mensual</dt><dd>${dinero(c.cuotaMes)}<small> · ${esc(textoCuota(c.cuota))}</small></dd>
      <dt>${c.saldo < 0 ? 'Saldo a favor' : 'Saldo'}</dt><dd class="total">${dinero(Math.abs(c.saldo))}</dd>
      <dt>Meses de atraso</dt><dd>${c.atraso}</dd>
      <dt>Último pago</dt><dd>${c.ultimoPago ? esc(dinero(c.ultimoPago.monto) + ' · ' + fechaCorta(c.ultimoPago.fecha)) : '—'}</dd>
    </dl>` : '<p class="nota" style="margin:0">Esta casa todavía no genera cuotas. Abre la ficha de cobros e indica la tarifa y desde qué mes se cobra.</p>'}`;
}

function cambio(){
  if (!selected) return;
  refrescarForma(selected);
  guardarForma(selected.aq.id);
}

async function cambiarTipo(nuevo){
  if (!requiereEdicion()) return;
  const layer = selected, aq = layer.aq;
  if (nuevo === aq.tipo) return;
  if (nuevo === 'sector' && !esPoligono(layer)){ aviso('Un sector debe ser un área cerrada.'); return; }
  if (nuevo === 'conector' && !esPunto(layer)){ aviso('Un conector es un punto: dibújalo con «Conector en T» o «en Y».'); return; }
  const tieneMovs = aq.tipo === 'casa' && ((pagosDe.get(aq.id) || []).length || (cobrosDe.get(aq.id) || []).length);
  if (tieneMovs && !confirm('Esta casa tiene cobros y pagos registrados. Si cambias su función dejará de generar cuotas, pero su historial de cobros se conserva. ¿Continuar?')) return;
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
  'cobros/resumen': renderCobResumen,
  'cobros/casas': renderCobCasas,
  'cobros/pagos': renderCobPagos,
  'cobros/tarifas': renderCobTarifas,
  'cobros/historial': renderCobHistorial,
  'cobros/cortes': renderCobCortes,
  'usuarios/permisos': renderPermisos
};
const GRUPO_DE = {'inicio':'inicio', 'resumen':'inicio', 'mapa':'mapa', 'incidencias/abiertas':'incidencias',
  'incidencias/resueltas':'incidencias', 'incidencias/calendario':'incidencias', 'incidencias/reportes':'incidencias', 'usuarios/solicitudes':'usuarios', 'usuarios/vecinos':'usuarios', 'usuarios/administradores':'usuarios', 'sectores':'gestion', 'cobros/resumen':'cobros', 'cobros/casas':'cobros', 'cobros/pagos':'cobros', 'cobros/tarifas':'cobros', 'cobros/historial':'cobros', 'cobros/cortes':'cobros', 'usuarios/permisos':'usuarios', 'configuracion':'config'};

function router(){
  let ruta = location.hash.replace(/^#\/?/, '') || 'inicio';
  if (ruta === 'casas'){ history.replaceState(null, '', '#/cobros/casas'); ruta = 'cobros/casas'; }
  let base = ruta, extra = null;
  if (ruta.startsWith('mapa/dibujar/')){ base = 'mapa'; extra = ruta.split('/')[2]; }
  else if (ruta.startsWith('configuracion/')){ base = 'configuracion'; extra = ruta.split('/')[1]; }
  if (!(base in GRUPO_DE)) base = 'inicio';
  if (miPerfil && !rutaPermitida(base)){ aviso('No tienes permiso para ver esa sección.'); history.replaceState(null, '', '#/inicio'); base = 'inicio'; }
  if (base === 'usuarios/permisos' && miPerfil && !esDev()){ history.replaceState(null, '', '#/inicio'); base = 'inicio'; }
  mostrarVista(base);
  if (base === 'mapa' && extra && PISTAS[extra] && extra !== 'acometida' && !puedeEditarMapa()){ history.replaceState(null, '', '#/mapa'); aviso('No tienes permiso para editar el mapa.'); }
  else if (base === 'mapa' && extra && PISTAS[extra] && extra !== 'acometida'){
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
  document.querySelectorAll('#barraInferior a[data-ruta]').forEach(a => { if (a.dataset.ruta === vistaActual) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
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
$('#menuInferior').addEventListener('click', e => { e.stopPropagation(); $('#menuBtn').click(); });
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
    <label class="interruptor interruptor-flujo" title="Flujo de agua"><input type="checkbox" data-flujo-id="${esc(l.aq.id)}" ${d.activo ? 'checked' : ''} aria-label="Agua en ${esc(d.nombre || 'sector')}"><span class="riel"></span></label></li>`;
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
    (pagosDe.get(l.aq.id) || []).filter(p => !p.anulado).forEach(p => { pagos.push({l, p}); if (String(p.fecha).startsWith(mes)) cobradoMes += num(p.monto); });
  });
  conDeuda.sort((a, b) => b.c.saldo - a.c.saldo);
  pagos.sort((a, b) => String(b.p.fecha).localeCompare(String(a.p.fecha)));
  const abiertas = incAbiertas();
  const conAgua = sectores.filter(s => s.aq.datos.activo).length;
  const hoy = capitalizar(new Date().toLocaleDateString('es', {weekday:'long', day:'numeric', month:'long', year:'numeric'}));
  sectores.sort((a, b) => String(a.aq.datos.nombre).localeCompare(String(b.aq.datos.nombre), 'es', {numeric:true}));

  const cont = $('#dash');
  const nombre = (miPerfil && miPerfil.nombre) ? miPerfil.nombre.split(' ')[0] : '';
  const acceso = (href, ic, txt, extra = '') => `<a href="${href}" ${extra}><span class="ic" aria-hidden="true">${ic}</span>${txt}</a>`;
  cont.innerHTML = `
    <section class="adm-hero">
      <div class="adm-hero-cab">
        <div><p class="hola">${nombre ? 'Hola, ' + esc(nombre) : esc(state.settings.nombre || 'Mi acueducto')}</p>
          <span class="cargo">${esc(miPerfil ? (nombreCargo(miPerfil) || NOMBRE_ROL[miPerfil.rol]) : '')}</span></div>
        <p class="fecha">${esc(hoy)}</p>
      </div>
      <div class="adm-hero-cifras">
        <a href="#/incidencias/abiertas"><span>Incidencias abiertas</span><b>${abiertas.length}</b></a>
        <a href="#/cobros/casas"><span>Por cobrar</span><b>${esc(dinero(total))}</b></a>
        <a href="#/sectores"><span>Sectores con agua</span><b>${conAgua} de ${sectores.length}</b></a>
      </div>
    </section>
    <nav class="adm-accesos" aria-label="Accesos rápidos">
      ${acceso('#/mapa', '🗺️', 'Mapa')}
      ${acceso('#/incidencias/abiertas', '⚠️', 'Incidencias')}
      ${acceso('#/incidencias/reportes', '📝', 'Reportes')}
      <button data-accion-pago><span class="ic" aria-hidden="true">💵</span>Registrar pago</button>
      ${acceso('#/cobros/casas', '🏠', 'Casas y cuentas')}
      ${acceso('#/cobros/cortes', '🚱', 'Cortes')}
      ${acceso('#/usuarios/solicitudes', '🙋', 'Solicitudes')}
      ${acceso('#/configuracion/general', '⚙️', 'Configuración')}
    </nav>
    <div class="kpis">
      ${kpi('#/incidencias/abiertas', abiertas.length, 'Incidencias abiertas',
          abiertas.length ? 'La más reciente ' + esc(Acu.hace(abiertas[0].creada_en)) : 'Todo en orden', abiertas.length ? 'alerta' : 'ok')}
      ${kpi('#/sectores', `${conAgua} <span>de ${sectores.length}</span>`, 'Sectores con agua',
          sectores.length ? (conAgua === sectores.length ? 'Todos con servicio' : `${sectores.length - conAgua} sin agua`) : 'Aún no hay sectores')}
      ${kpi('#/cobros/casas', casas.length, 'Casas', sinCon ? `${sinCon} sin conexión a tubería` : (casas.length ? 'Todas conectadas' : 'Aún no hay casas'), sinCon ? 'aviso' : '')}
      ${kpi('#/cobros/casas', esc(dinero(total)), 'Por cobrar', `${conDeuda.length} ${conDeuda.length === 1 ? 'casa' : 'casas'} con deuda`, total > 0 ? 'deuda' : '')}
      ${kpi('#/cobros/resumen', esc(dinero(cobradoMes)), 'Cobrado este mes', 'Ver el resumen de cobros')}
    </div>
    <div class="rejilla">
      <article class="tarjeta" data-seccion="incidencias">
        <header><h2>Incidencias abiertas</h2><a href="#/incidencias/abiertas">Ver todas</a></header>
        ${abiertas.length ? abiertas.slice(0, 4).map(tarjetaIncidencia).join('') : '<p class="vacio">✓ No hay incidencias abiertas.</p>'}
      </article>
      <article class="tarjeta" data-seccion="sectores">
        <header><h2>Flujo de agua por sector</h2><a href="#/sectores">Administrar</a></header>
        ${sectores.length ? `<ul class="lista">${sectores.map(filaSector).join('')}</ul>` : `<p class="vacio">Aún no hay sectores.${esDev() ? ' <a href="#/mapa/dibujar/sector">Dibujar un sector</a>' : ''}</p>`}
      </article>
      <article class="tarjeta" data-seccion="cobros">
        <header><h2>Casas con más deuda</h2><a href="#/cobros/casas">Ver casas</a></header>
        ${conDeuda.length ? `<ul class="lista">${conDeuda.slice(0, 6).map(({l, c}) => {
            const est = textoEstado(c);
            return `<li><button class="item" data-ficha-inicio="${esc(l.aq.id)}"><span>${esc(nombreCasa(l.aq.datos))}<small>${esc(l.aq.datos.responsable || 'Sin responsable')}</small></span><span class="pill ${est.cls}">${esc(est.txt)}</span></button></li>`;
          }).join('')}</ul>` : '<p class="vacio">✓ Ninguna casa tiene deuda.</p>'}
      </article>
      <article class="tarjeta" data-seccion="pagos">
        <header><h2>Últimos pagos</h2><a href="#/cobros/pagos">Ver pagos</a></header>
        ${pagos.length ? `<ul class="lista">${pagos.slice(0, 6).map(({l, p}) =>
            `<li><button class="item" data-recibo-inicio="${esc(p.id)}"><span>${esc(nombreCasa(l.aq.datos))}<small>${esc(fechaCorta(p.fecha))} · ${esc(numRecibo(p.recibo))}</small></span><b class="monto">${esc(dinero(p.monto))}</b></button></li>`).join('')}</ul>`
          : '<p class="vacio">Todavía no hay pagos registrados.</p>'}
      </article>
    </div>`;
  cont.querySelectorAll('[data-ficha-inicio]').forEach(b => b.addEventListener('click', () => abrirFicha(b.dataset.fichaInicio)));
  cont.querySelectorAll('[data-recibo-inicio]').forEach(b => b.addEventListener('click', () => mostrarRecibo(b.dataset.reciboInicio)));
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
    nucleos += nucleosDe(d); personas += personasDe(d);
    if (!estaConectada(l.aq.id)) sinCon++;
    if (c.aplica){
      esperado += c.cuotaMes;
      if (c.saldo > 0){ deben++; porCobrar += c.saldo; } else if (c.saldo < 0) adelantadas++; else alDia++;
    }
    (pagosDe.get(l.aq.id) || []).filter(p => !p.anulado).forEach(p => {
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
        <header><h2>Casas</h2><a href="#/cobros/casas">Ver casas</a></header>
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
    cont.innerHTML = `<div class="vacio-grande">Aún no hay sectores.${esDev() ? '<br><small><a href="#/mapa/dibujar/sector">Dibuja el primero en el mapa</a>.</small>' : ''}</div>`;
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
        <label class="interruptor interruptor-flujo" title="Flujo de agua"><input type="checkbox" data-flujo-id="${esc(l.aq.id)}" ${activo ? 'checked' : ''} aria-label="Agua en ${esc(d.nombre || 'sector')}"><span class="riel"></span></label>
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
  const [s, p, r, c, a, v] = await Promise.all([
    sb.from('solicitudes_registro').select('*').order('created_at', {ascending:false}).limit(300),
    sb.from('perfiles').select('*').order('created_at', {ascending:true}),
    sb.from('reportes').select('*, perfiles(nombre, celular, numero_casa, email)').order('created_at', {ascending:false}).limit(500),
    sb.from('cargos').select('*'),
    sb.rpc('lista_administradores'),
    sb.from('casas_vecino').select('*')
  ]);
  if (!s.error) solicitudes = s.data || [];
  if (!p.error) perfilesLista = p.data || [];
  if (!r.error) reportesLista = r.data || [];
  if (!c.error) cargosLista = c.data || [];
  if (!a.error) adminsLista = a.data || [];
  if (!v.error) vinculos = v.data || [];
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
  const nombre = miPerfil.nombre || miPerfil.email || '';
  $('#miAvatar').textContent = (nombre.trim().charAt(0) || '?').toUpperCase();
  $('#perfTitulo').textContent = miPerfil.nombre || 'Mi perfil';
  AcuClave.limpiar($('#dlgPerfil'));
  $('#miNombre').value = miPerfil.nombre || '';
  $('#miCelular').value = miPerfil.celular || '';
  $('#miCorreo').textContent = miPerfil.email || '';
  $('#miCargo').textContent = (nombreCargo(miPerfil) || NOMBRE_ROL[miPerfil.rol]) + (nombreCargo(miPerfil) && miPerfil.rol === 'desarrollador' ? ' · Desarrollador' : '');
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
    if (!confirm(`¿Eliminar definitivamente la cuenta de ${p.nombre || p.email}?\n\nSe borran su correo, celular y acceso. Sus reportes se conservan sin su nombre. Si alguna vez fue administrador, las incidencias que registró o atendió se conservan con su nombre y cargo como registro de trabajo.`)) return;
    const r = await llamarFuncion({accion:'eliminar', id:p.id});
    if (r && r.ok){ aviso(r.mensaje); cargarUsuarios(); }
  }));
  enlazarChipsCasas(cont);
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
    <thead><tr><th>Nombre</th><th>Correo</th><th>Celular</th><th>Casa</th>${opciones.editarCasa ? '<th>Clasificación</th>' : ''}${opciones.conRol ? '<th>Rol</th>' : ''}<th>Estado</th><th></th></tr></thead>
    <tbody>${lista.map(p => {
      const casa = p.casa_id && capas.get(p.casa_id);
      const puede = opciones.puedeGestionar(p);
      return `<tr>
        <td><b>${esc(p.nombre || '—')}</b>${p.rol !== 'vecino' ? `<span class="rol-vecino">${esc(nombreCargo(p) || NOMBRE_ROL[p.rol])}</span>` : ''}</td>
        <td>${p.email ? esc(p.email) : '<span class="nota">(oculto)</span>'}</td>
        <td>${telLink(p.celular)}</td>
        <td>${opciones.editarCasa ? chipsCasas(p.id, puede) : esc(casa ? nombreCasa(casa.aq.datos) : (p.numero_casa ? 'Casa ' + p.numero_casa : '—'))}</td>
        ${opciones.editarCasa ? `<td>${etiquetaClase(clasificarVecino(p.id))}</td>` : ''}
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
  const porId = new Map();
  perfilesLista.forEach(p => porId.set(p.id, p));
  adminsLista.forEach(a => { if (!porId.has(a.id)) porId.set(a.id, a); else Object.assign(porId.get(a.id), {cargo:a.cargo, genero:a.genero}); });
  const todos = [...porId.values()].sort((a, b) => String(a.nombre || a.email || '').localeCompare(String(b.nombre || b.email || ''), 'es'));
  const lista = todos.filter(p => !q || [p.nombre, p.email, p.celular, p.numero_casa, nombreCargo(p)].join(' ').toLowerCase().includes(q));
  const nAdm = todos.filter(p => p.rol !== 'vecino').length;
  $('#vecConteo').textContent = `${lista.length} de ${todos.length} vecinos${nAdm ? ` · ${nAdm} ${nAdm === 1 ? 'es administrador' : 'son administradores'}` : ''}`;
  campoClaveVecino();
  const cont = $('#vecTabla');
  cont.innerHTML = tablaCuentas(lista, {vacio: todos.length ? 'Ningún vecino coincide con la búsqueda.' : 'Todavía no hay vecinos con cuenta. Aparecerán aquí al aprobar sus solicitudes.',
    puedeGestionar: p => p.rol === 'vecino' || esDev(), editarCasa: true});
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
            <a class="btn chico" href="#/usuarios/permisos" data-ver-permisos="${esc(p.id)}">Permisos</a>
            <button class="btn chico peligro" data-bajar="${esc(p.id)}">Bajar a vecino</button></div>`}</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
  enlazarCuentas(cont);
  cont.querySelectorAll('[data-cargo]').forEach(s => s.addEventListener('change', () => cambiarPerfil(s.dataset.cargo, {cargo:s.value || null}, 'Cargo actualizado.')));
  cont.querySelectorAll('[data-genero]').forEach(s => s.addEventListener('change', () => cambiarPerfil(s.dataset.genero, {genero:s.value}, 'Listo: el cargo se muestra como ' + (s.value === 'F' ? 'dama.' : 'caballero.'))));
  cont.querySelectorAll('[data-ver-permisos]').forEach(a => a.addEventListener('click', () => { permElegido = a.dataset.verPermisos; permEdicion = null; }));
  cont.querySelectorAll('[data-bajar]').forEach(b => b.addEventListener('click', () => {
    const p = adminsLista.find(x => x.id === b.dataset.bajar);
    if (p && confirm(`¿Quitarle la administración a ${p.nombre || 'esta persona'}? Vuelve a ser vecino: conserva su cuenta y sus reportes, pero pierde el cargo y el acceso a la administración. Las incidencias que atendió siguen registradas con su nombre y cargo.`))
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
      <div class="fila">${r.punto ? `<button class="btn chico" data-ver-rep="${esc(r.id)}">📍 Ver en el mapa</button>` : '<span class="nota">Sin ubicación marcada</span>'}</div>
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

/* =====================================================================
   SISTEMA DE COBROS
   · tarifas: cuánto se cobra al mes y cómo (por casa, por núcleo o por persona)
   · cobros: cargos de cada casa (cuotas mensuales automáticas, deuda anterior, cargos extra)
   · pagos: abonos con número de recibo. Nada se borra: se anula con un motivo.
   Saldo = cargos no anulados − pagos no anulados.
   ===================================================================== */
let tarifas = [], cobrosListos = false;
const cobrosDe = new Map(), pagosDe = new Map();
const METODOS = {efectivo:'Efectivo', transferencia:'Transferencia', yappy:'Yappy', cheque:'Cheque', otro:'Otro'};
const MODOS_TARIFA = {casa:'Monto fijo por casa', nucleo:'Por cada núcleo familiar', persona:'Por cada persona'};
const CONCEPTOS_EXTRA = ['Multa', 'Reconexión del servicio', 'Instalación o acometida nueva', 'Materiales', 'Deuda anterior', 'Otro'];
const round2 = n => Math.round(num(n) * 100) / 100;
const mesActual = () => hoyISO().slice(0, 7);
function nombreMes(per, corto){
  if (!/^\d{4}-\d{2}$/.test(per || '')) return per || '';
  const [y, m] = per.split('-').map(Number);
  return capitalizar(new Date(y, m - 1, 1).toLocaleDateString('es', corto ? {month:'short', year:'numeric'} : {month:'long', year:'numeric'}));
}
const fechaCorta = f => f ? new Date(String(f).slice(0, 10) + 'T12:00:00').toLocaleDateString('es', {day:'numeric', month:'short', year:'numeric'}) : '—';
const numRecibo = n => n ? 'N.º ' + String(n).padStart(6, '0') : '—';

function ponerMovimiento(mapa, fila){
  if (!mapa.has(fila.forma_id)) mapa.set(fila.forma_id, []);
  const l = mapa.get(fila.forma_id), i = l.findIndex(x => x.id === fila.id);
  if (i >= 0) l[i] = fila; else l.push(fila);
}
function quitarMovimiento(mapa, id){
  for (const [forma, l] of mapa){ const i = l.findIndex(x => x.id === id); if (i >= 0){ l.splice(i, 1); return forma; } }
  return null;
}
const todosLosPagos = () => [...pagosDe.values()].flat();
const nucleosDe = d => Array.isArray(d.nucleosLista) ? d.nucleosLista.length : Math.max(0, num(d.nucleos));
const personasDe = d => Array.isArray(d.nucleosLista) ? d.nucleosLista.reduce((s, n) => s + Math.max(0, num(n.personas)), 0) : Math.max(0, num(d.personas));
/* Tarifa de una casa: la suya propia, si no la de su categoría, si no la general */
const tarifaDe = d => { const c = categoriaDe(d); return tarifas.find(t => t.id === (d.tarifa || (c && c.tarifa_id) || state.settings.tarifaDefecto)) || null; };
const tieneEspecial = d => d.cuotaEspecial !== '' && d.cuotaEspecial != null && isFinite(Number(d.cuotaEspecial));

/* Cuota mensual de una casa (misma regla que la base de datos) */
function cuotaMensual(d){
  const t = tarifaDe(d);
  if (tieneEspecial(d)) return {monto:round2(d.cuotaEspecial), especial:true, tarifa:t, unidades:1};
  if (!t) return {monto:0, especial:false, tarifa:null, unidades:0};
  const n = t.modo === 'nucleo' ? nucleosDe(d) : t.modo === 'persona' ? personasDe(d) : 1;
  return {monto:round2(num(t.monto) * n), especial:false, tarifa:t, unidades:n};
}
function textoCuota(q){
  if (q.especial) return 'Cuota especial';
  if (!q.tarifa) return 'Sin tarifa';
  if (q.tarifa.modo === 'nucleo') return `${q.unidades} ${q.unidades === 1 ? 'núcleo' : 'núcleos'} × ${dinero(q.tarifa.monto)}`;
  if (q.tarifa.modo === 'persona') return `${q.unidades} ${q.unidades === 1 ? 'persona' : 'personas'} × ${dinero(q.tarifa.monto)}`;
  return q.tarifa.nombre;
}
const ordenCargo = (a, b) => String(a.fecha).localeCompare(String(b.fecha)) || String(a.periodo || '').localeCompare(String(b.periodo || ''))
  || (a.tipo === 'saldo_inicial' ? -1 : b.tipo === 'saldo_inicial' ? 1 : 0) || String(a.created_at).localeCompare(String(b.created_at));

/* Estado de cuenta de una casa. Los pagos se aplican a los cargos más antiguos primero. */
function cuenta(aq, excluirPago){
  const d = aq.datos || {}, id = aq.id;
  const cargos = (cobrosDe.get(id) || []).filter(c => !c.anulado).sort(ordenCargo);
  const pagos = (pagosDe.get(id) || []).filter(p => !p.anulado && p.id !== excluirPago);
  const cargado = round2(cargos.reduce((s, c) => s + num(c.monto), 0));
  const pagado = round2(pagos.reduce((s, p) => s + num(p.monto), 0));
  const saldo = round2(cargado - pagado);
  let resto = pagado;
  const pendientes = [];
  cargos.forEach(c => {
    const m = num(c.monto);
    if (resto >= m - 0.005) resto = round2(resto - m);
    else { pendientes.push({...c, falta:round2(m - resto)}); resto = 0; }
  });
  const mes = mesActual();
  const atraso = pendientes.filter(c => c.tipo === 'cuota' && c.periodo < mes).length;
  const q = cuotaMensual(d);
  const ultimoPago = pagos.reduce((a, p) => (!a || String(p.fecha) > String(a.fecha) ? p : a), null);
  const exonerada = d.cobroActivo === false;
  const aplica = cargos.length > 0 || pagos.length > 0 || !!d.inicioCobro;
  const arreglo = arregloVigente(id), avance = arreglo ? avanceArreglo(arreglo, saldo) : null;
  const nivel = saldo <= 0 ? 'ok' : arreglo ? (avance.atrasado ? 'bad' : 'warn') : atraso >= 3 ? 'bad' : 'warn';
  const res = {cuotaMes:q.monto, cuota:q, cargado, esperado:cargado, pagado, saldo, atraso, pendientes, aplica, exonerada, nivel,
    ultimoPago, especial:q.especial, meses:cargos.filter(c => c.tipo === 'cuota').length, arreglo, avance};
  const sc = situacionCorte(aq, res);
  res.corte = sc.estado === 'normal' || sc.estado === 'atendible' ? null : sc.estado;
  if (res.corte) res.nivel = 'bad';
  return res;
}
function textoEstado(c){
  if (c.corte === 'cortado') return {cls:'bad', txt:`🚱 Cortada · debe ${dinero(Math.max(0, c.saldo))}`};
  if (c.corte === 'vencido') return {cls:'bad', txt:'⛔ Aviso vencido: cortar'};
  if (c.corte === 'notificado') return {cls:'bad', txt:'⚠ Avisada de corte'};
  if (c.corte === 'notificar') return {cls:'bad', txt:`Notificar corte · ${c.atraso} meses`};
  if (!c.aplica) return {cls:'nada', txt:c.exonerada ? 'Exonerada' : 'Sin cobro'};
  if (c.saldo < 0) return {cls:'ok', txt:'Adelantado ' + dinero(-c.saldo)};
  if (c.saldo === 0) return {cls:'ok', txt:c.exonerada ? 'Exonerada · al día' : 'Al día'};
  if (c.arreglo) return {cls:c.avance.atrasado ? 'bad' : 'warn', txt:`Arreglo de pago · ${c.avance.cubiertas}/${c.arreglo.cuotas}${c.avance.atrasado ? ' · atrasado' : ''}`};
  if (c.atraso >= 3) return {cls:'bad', txt:`Morosa · debe ${dinero(c.saldo)}`};
  if (c.atraso >= 1) return {cls:'warn', txt:`Debe ${dinero(c.saldo)} · ${c.atraso} ${c.atraso === 1 ? 'mes' : 'meses'}`};
  return {cls:'warn', txt:`Pendiente ${dinero(c.saldo)} (este mes)`};
}
/* Hasta qué mes queda cubierta una casa con saldo a favor o al día */
function cubreHasta(aq, c){
  const cuotas = (cobrosDe.get(aq.id) || []).filter(x => x.tipo === 'cuota' && !x.anulado).map(x => x.periodo).sort();
  if (c.saldo > 0 || !cuotas.length) return '';
  let [y, m] = cuotas[cuotas.length - 1].split('-').map(Number);
  const extra = c.cuotaMes > 0 ? Math.floor((-c.saldo + 0.005) / c.cuotaMes) : 0;
  m += extra; while (m > 12){ m -= 12; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/* ---------- Arreglos de pago ---------- */
const arreglosDe = new Map();
async function cargarArreglos(){
  const {data, error} = await sb.from('arreglos_pago').select('*').order('created_at');
  if (error) return;
  arreglosDe.clear();
  (data || []).forEach(a => { if (!arreglosDe.has(a.forma_id)) arreglosDe.set(a.forma_id, []); arreglosDe.get(a.forma_id).push(a); });
}
const arregloVigente = id => (arreglosDe.get(id) || []).find(a => a.estado === 'vigente') || null;
function sumarMeses(per, n){ let [y, m] = per.split('-').map(Number); m += n; while (m > 12){ m -= 12; y++; } while (m < 1){ m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }
/* Avance de un arreglo: lo que ha bajado la deuda desde que se acordó */
function avanceArreglo(a, saldo){
  const deuda = num(a.deuda), avance = Math.min(deuda, Math.max(0, round2(deuda - Math.max(0, saldo))));
  const cubiertas = Math.min(a.cuotas, Math.floor((avance + 0.005) / num(a.monto_cuota)));
  const inicio = String(a.inicio).slice(0, 7), proxima = cubiertas < a.cuotas ? sumarMeses(inicio, cubiertas) : null;
  const atrasado = !!proxima && mesActual() > proxima;
  return {avance, cubiertas, proxima, atrasado, restante:round2(deuda - avance)};
}
/* Meses que cubre un saldo a favor, empezando después de la última cuota generada */
function mesesAdelantados(aq, favor, cuotaMes){
  if (favor <= 0 || cuotaMes <= 0) return [];
  const cuotas = (cobrosDe.get(aq.id) || []).filter(x => x.tipo === 'cuota' && !x.anulado).map(x => x.periodo).sort();
  const desde = cuotas.length ? sumarMeses(cuotas[cuotas.length - 1], 1) : mesActual();
  const n = Math.floor((favor + 0.005) / cuotaMes);
  return Array.from({length:Math.min(n, 24)}, (_, i) => sumarMeses(desde, i));
}

/* ---------- Casas de cada vecino (un vecino puede tener varias) ---------- */
let vinculos = [];
const casasDeUsuario = id => vinculos.filter(v => v.usuario_id === id).map(v => v.forma_id);
const usuariosDeCasa = fid => vinculos.filter(v => v.forma_id === fid).map(v => v.usuario_id);
async function vincularCasa(uid, fid){
  if (!uid || !fid) return;
  if (!await tarea(sb.from('casas_vecino').insert({usuario_id:uid, forma_id:fid}), 'No se pudo vincular la casa')) return;
  const p = perfilesLista.find(x => x.id === uid);
  if (p && !p.casa_id) await sb.from('perfiles').update({casa_id:fid}).eq('id', uid);
  aviso('Casa vinculada.'); await cargarUsuarios();
  if ($('#dlgFicha').open) renderFicha();
}
async function desvincularCasa(uid, fid){
  if (!await tarea(sb.from('casas_vecino').delete().eq('usuario_id', uid).eq('forma_id', fid), 'No se pudo quitar la casa')) return;
  const p = perfilesLista.find(x => x.id === uid);
  if (p && p.casa_id === fid){
    const otra = casasDeUsuario(uid).find(x => x !== fid) || null;
    await sb.from('perfiles').update({casa_id:otra}).eq('id', uid);
  }
  aviso('Casa desvinculada.'); await cargarUsuarios();
  if ($('#dlgFicha').open) renderFicha();
}
function chipsCasas(uid, editable){
  const ids = casasDeUsuario(uid);
  const chips = ids.map(fid => { const l = capas.get(fid);
    return `<span class="chip-casa">${esc(l ? nombreCasa(l.aq.datos) : 'Casa eliminada')}${editable ? `<button data-quitar-casa="${esc(uid)}|${esc(fid)}" aria-label="Quitar casa">×</button>` : ''}</span>`; }).join('');
  const libres = datosGenerales().casas.filter(l => !ids.includes(l.aq.id))
    .sort((a, b) => String(a.aq.datos.numero).localeCompare(String(b.aq.datos.numero), 'es', {numeric:true}));
  return `<div class="casas-vecino">${chips || '<span class="nota">Sin casa</span>'}
    ${editable ? `<select class="sel-chico" data-agregar-casa="${esc(uid)}"><option value="">＋ Agregar casa</option>${libres.map(l => `<option value="${esc(l.aq.id)}">${esc(nombreCasa(l.aq.datos))}${l.aq.datos.responsable ? ' — ' + esc(l.aq.datos.responsable) : ''}</option>`).join('')}</select>` : ''}</div>`;
}
function enlazarChipsCasas(cont){
  cont.querySelectorAll('[data-quitar-casa]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const [uid, fid] = b.dataset.quitarCasa.split('|'), l = capas.get(fid);
    if (confirm(`¿Quitar ${l ? nombreCasa(l.aq.datos) : 'esta casa'} de esta cuenta? El vecino dejará de ver su estado de cuenta.`)) desvincularCasa(uid, fid);
  }));
  cont.querySelectorAll('[data-agregar-casa]').forEach(s => s.addEventListener('change', () => { if (s.value) vincularCasa(s.dataset.agregarCasa, s.value); }));
}

/* =====================================================================
   CORTES DE AGUA
   Regla: se permite deber hasta N meses (Configuración). Cuando una casa
   supera ese atraso y no tiene un arreglo de pago al día, hay que avisarle.
   Si no lo atiende antes de la fecha límite, se registra el corte.
   Las cuotas se siguen generando cada mes mientras tanto.
   ===================================================================== */
const cortesDe = new Map();
async function cargarCortes(){
  const {data, error} = await sb.from('cortes').select('*').order('notificado_en');
  if (error) return;
  cortesDe.clear();
  (data || []).forEach(k => { if (!cortesDe.has(k.forma_id)) cortesDe.set(k.forma_id, []); cortesDe.get(k.forma_id).push(k); });
}
const corteActivo = id => (cortesDe.get(id) || []).find(k => k.estado === 'notificado' || k.estado === 'cortado') || null;
const mesesTolerancia = () => Math.max(1, num(state.settings.mesesCorte) || 2);
/* Situación de corte de una casa según su cuenta */
function situacionCorte(aq, c){
  const k = corteActivo(aq.id);
  const excede = c.atraso > mesesTolerancia() && !(c.arreglo && !c.avance.atrasado) && !c.exonerada;
  if (k && k.estado === 'cortado') return {estado:'cortado', k, excede};
  if (k && k.estado === 'notificado'){
    const vencido = hoyISO() > String(k.fecha_limite);
    return {estado:excede ? (vencido ? 'vencido' : 'notificado') : 'atendible', k, excede, vencido};
  }
  return {estado:excede ? 'notificar' : 'normal', k:null, excede};
}
/* Clasificación automática de una casa */
function clasificar(aq, c){
  if (!c.aplica) return null;
  const s = situacionCorte(aq, c);
  if (s.estado !== 'normal' && s.estado !== 'atendible' || c.atraso > mesesTolerancia()) return 'intervencion';
  if (c.arreglo || c.atraso >= 1) return 'atencion';
  if (c.saldo < 0 && mesesAdelantados(aq, -c.saldo, c.cuotaMes).length >= 1) return 'excelencia';
  return 'aldia';
}
const CLASES = {excelencia:{txt:'Excelencia', icono:'⭐'}, aldia:{txt:'Al Día', icono:'✓'}, atencion:{txt:'Atención', icono:'!'}, intervencion:{txt:'Intervención', icono:'⚠'}};
const ORDEN_CLASES = ['excelencia', 'aldia', 'atencion', 'intervencion'];
const etiquetaClase = k => k ? `<span class="clase clase-${k}"><i>${CLASES[k].icono}</i>${CLASES[k].txt}</span>` : '<span class="nota">—</span>';
/* Clasificación de un vecino: la peor de sus casas (Excelencia solo si todas lo son) */
function clasificarVecino(uid){
  const cls = casasDeUsuario(uid).map(fid => capas.get(fid)).filter(Boolean).map(l => clasificar(l.aq, cuenta(l.aq))).filter(Boolean);
  if (!cls.length) return null;
  if (cls.every(k => k === 'excelencia')) return 'excelencia';
  return cls.filter(k => k !== 'excelencia').reduce((a, k) => ORDEN_CLASES.indexOf(k) > ORDEN_CLASES.indexOf(a) ? k : a, 'aldia');
}
/* Si una casa avisada ya pagó o hizo un arreglo, su aviso se da por atendido solo */
let revisandoAvisos = false;
async function revisarAvisos(){
  if (revisandoAvisos) return;
  revisandoAvisos = true;
  try {
    for (const [fid, lista] of cortesDe){
      const k = lista.find(x => x.estado === 'notificado'), l = capas.get(fid);
      if (!k || !l) continue;
      if (situacionCorte(l.aq, cuenta(l.aq)).estado !== 'atendible') continue;
      const {data} = await sb.from('cortes').update({estado:'atendido', nota:'Se puso al día o hizo un arreglo de pago.'}).eq('id', k.id).select().single();
      if (data) Object.assign(k, data);
    }
  } finally { revisandoAvisos = false; }
}
const revisarAvisosPronto = debounce(() => revisarAvisos().then(() => { actualizarBadgeCortes(); renderVistaPronto(); }), 1500);
function pendientesCorte(){
  let notificar = 0, vencidos = 0;
  datosGenerales().casas.forEach(l => { const s = situacionCorte(l.aq, cuenta(l.aq)); if (s.estado === 'notificar') notificar++; if (s.estado === 'vencido') vencidos++; });
  return {notificar, vencidos, total:notificar + vencidos};
}
function actualizarBadgeCortes(){
  const n = pendientesCorte().total;
  document.querySelectorAll('[data-badge-cortes]').forEach(b => { b.textContent = n; b.hidden = !n; });
}
/* Acciones */
async function notificarCorte(aq, fechaLimite){
  const c = cuenta(aq);
  const fila = await consultaConFila(sb.from('cortes').insert({forma_id:aq.id, deuda:c.saldo, meses:c.atraso, fecha_limite:fechaLimite}).select().single(), 'No se pudo registrar el aviso');
  if (!fila) return false;
  if (!cortesDe.has(aq.id)) cortesDe.set(aq.id, []);
  cortesDe.get(aq.id).push(fila);
  aviso(`Aviso de corte registrado para ${nombreCasa(aq.datos)}. El vecino lo verá en su perfil.`, 6000);
  refrescarCobrosUI(aq.id); actualizarBadgeCortes();
  return true;
}
async function cambiarCorte(aq, estado, nota){
  const k = corteActivo(aq.id); if (!k) return false;
  const fila = await consultaConFila(sb.from('cortes').update({estado, ...(nota ? {nota} : {})}).eq('id', k.id).select().single(), 'No se pudo actualizar');
  if (!fila) return false;
  Object.assign(k, fila);
  refrescarCobrosUI(aq.id); actualizarBadgeCortes();
  return true;
}
async function reincorporar(aq){
  const monto = round2(state.settings.montoReconexion);
  const nota = prompt(`Reincorporar el servicio de agua de ${nombreCasa(aq.datos)}.\nNota (opcional), por ejemplo: pagó la deuda, hizo un arreglo…`, '');
  if (nota === null) return;
  if (monto > 0 && confirm(`¿Cobrar la reconexión del servicio (${dinero(monto)})? Se agregará como cargo en su cuenta.`)){
    await consultaConFila(sb.from('cobros').insert({forma_id:aq.id, tipo:'extra', concepto:'Reconexión del servicio', monto, fecha:hoyISO()}).select().single(), 'No se pudo agregar el cargo de reconexión')
      .then(f => { if (f) ponerMovimiento(cobrosDe, f); });
  }
  if (await cambiarCorte(aq, 'reincorporado', nota.trim() || null)) aviso(`Servicio reincorporado en ${nombreCasa(aq.datos)}.`, 5000);
}
function accionesCorte(aq, c, compacto){
  const s = situacionCorte(aq, c), lim = sumarDias(hoyISO(), num(state.settings.diasAvisoCorte) || 8);
  if (s.estado === 'notificar') return `<div class="corte-caja notificar"><b>⚠ Debe ser notificada para corte</b>
      <p>${c.atraso} meses de atraso (se permiten ${mesesTolerancia()}) y no tiene un arreglo de pago al día.</p>
      <div class="fila"><label class="rango">Fecha límite <input type="date" data-limite="${esc(aq.id)}" value="${lim}"></label>
      <button class="btn chico primario" data-notificar="${esc(aq.id)}">Notificar corte</button></div></div>`;
  if (s.estado === 'notificado' || s.estado === 'vencido') return `<div class="corte-caja ${s.estado}"><b>${s.estado === 'vencido' ? '⛔ Aviso vencido: corresponde cortar el servicio' : '⚠ Aviso de corte enviado'}</b>
      <p>Notificada el ${esc(fechaCorta(s.k.notificado_en))}${s.k.notificado_por_nombre ? ' por ' + esc(s.k.notificado_por_nombre) : ''} · fecha límite <b>${esc(fechaCorta(s.k.fecha_limite))}</b>${s.estado === 'vencido' ? '' : ` (${diasHasta(s.k.fecha_limite)} días)`}</p>
      <div class="fila"><button class="btn chico ${s.estado === 'vencido' ? 'primario' : ''}" data-cortar="${esc(aq.id)}">Registrar corte</button>
      <button class="btn chico" data-anular-aviso="${esc(aq.id)}">Anular aviso</button></div></div>`;
  if (s.estado === 'cortado') return `<div class="corte-caja cortado"><b>🚱 Servicio cortado</b>
      <p>Desde el ${esc(fechaCorta(s.k.cortado_en))}${s.k.cortado_por_nombre ? ' (' + esc(s.k.cortado_por_nombre) + ')' : ''}. Las cuotas se siguen cobrando cada mes.</p>
      <div class="fila"><button class="btn chico primario" data-reincorporar="${esc(aq.id)}">Reincorporar servicio</button></div></div>`;
  return compacto ? '' : '';
}
function enlazarCorte(cont){
  cont.querySelectorAll('[data-notificar]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const l = capas.get(b.dataset.notificar), lim = cont.querySelector(`[data-limite="${b.dataset.notificar}"]`).value;
    if (!l || !lim){ aviso('Elige la fecha límite.'); return; }
    if (confirm(`¿Notificar corte de agua a ${nombreCasa(l.aq.datos)}? Tendrá hasta el ${fechaCorta(lim)} para pagar o hacer un arreglo.`)) notificarCorte(l.aq, lim);
  }));
  cont.querySelectorAll('[data-cortar]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const l = capas.get(b.dataset.cortar), s = situacionCorte(l.aq, cuenta(l.aq));
    const msg = s.estado === 'vencido' ? `¿Registrar el corte de agua de ${nombreCasa(l.aq.datos)}?` : `La fecha límite aún no llega (${fechaCorta(s.k.fecha_limite)}). ¿Registrar el corte de todas formas?`;
    if (confirm(msg) && await cambiarCorte(l.aq, 'cortado')) aviso(`Corte registrado en ${nombreCasa(l.aq.datos)}.`, 5000);
  }));
  cont.querySelectorAll('[data-anular-aviso]').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const l = capas.get(b.dataset.anularAviso), nota = prompt('¿Por qué se anula el aviso de corte?', '');
    if (nota === null) return;
    if (await cambiarCorte(l.aq, 'anulado', nota.trim() || 'Anulado por la administración')) aviso('Aviso anulado.');
  }));
  cont.querySelectorAll('[data-reincorporar]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); reincorporar(capas.get(b.dataset.reincorporar).aq); }));
}
function sumarDias(iso, n){ const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function diasHasta(iso){ return Math.max(0, Math.round((new Date(String(iso).slice(0, 10) + 'T12:00:00') - new Date(hoyISO() + 'T12:00:00')) / 864e5)); }

/* --- Sección Cortes de agua --- */
function renderCobCortes(){
  $('#ctMeses').value = mesesTolerancia();
  $('#ctDias').value = num(state.settings.diasAvisoCorte) || 8;
  $('#ctReconexion').value = round2(state.settings.montoReconexion).toFixed(2);
  const filas = datosGenerales().casas.map(l => { const c = cuenta(l.aq); return {l, c, s:situacionCorte(l.aq, c)}; });
  const grupo = (est, vacio) => {
    const lista = filas.filter(x => est.includes(x.s.estado)).sort((a, b) => b.c.saldo - a.c.saldo);
    return lista.length ? `<div class="lista-cortes">${lista.map(x => `<article class="tarjeta corte-fila" data-ficha-corte="${esc(x.l.aq.id)}">
        <header><h2>${esc(nombreCasa(x.l.aq.datos))}</h2><span class="nota">${esc(x.l.aq.datos.responsable || 'Sin representante')}</span></header>
        <p class="nota">Debe <b class="rojo">${esc(dinero(x.c.saldo))}</b> · ${x.c.atraso} ${x.c.atraso === 1 ? 'mes' : 'meses'} de atraso${x.c.arreglo ? ' · arreglo de pago atrasado' : ''}</p>
        ${accionesCorte(x.l.aq, x.c)}</article>`).join('')}</div>` : `<p class="vacio">${vacio}</p>`;
  };
  const cerrados = [...cortesDe.values()].flat().filter(k => ['atendido', 'reincorporado', 'anulado'].includes(k.estado))
    .sort((a, b) => String(b.cerrado_en).localeCompare(String(a.cerrado_en))).slice(0, 20);
  const n = k => filas.filter(x => k.includes(x.s.estado)).length;
  $('#ctCont').innerHTML = `
    <h2 class="sub-seccion">Para notificar <span class="badge">${n(['notificar'])}</span></h2>
    <p class="nota">Casas con más de ${mesesTolerancia()} meses de atraso y sin arreglo de pago al día.</p>
    ${grupo(['notificar'], '✓ Ninguna casa necesita aviso de corte.')}
    <h2 class="sub-seccion">Avisos vigentes <span class="badge">${n(['notificado', 'vencido'])}</span></h2>
    ${grupo(['vencido', 'notificado'], 'No hay avisos de corte vigentes.')}
    <h2 class="sub-seccion">Casas con el servicio cortado <span class="badge">${n(['cortado'])}</span></h2>
    ${grupo(['cortado'], 'Ninguna casa tiene el servicio cortado.')}
    <h2 class="sub-seccion">Historial reciente</h2>
    ${cerrados.length ? `<div class="tabla-cont"><table class="tabla"><thead><tr><th>Casa</th><th>Aviso</th><th>Resultado</th><th>Fecha</th><th>Por</th><th>Nota</th></tr></thead><tbody>
      ${cerrados.map(k => { const l = capas.get(k.forma_id); return `<tr><td>${esc(l ? nombreCasa(l.aq.datos) : 'Casa eliminada')}</td><td>${esc(fechaCorta(k.notificado_en))}</td>
        <td><span class="pill ${k.estado === 'anulado' ? 'nada' : 'ok'}">${k.estado === 'atendido' ? 'Atendido' : k.estado === 'reincorporado' ? 'Reincorporado' : 'Anulado'}</span>${k.cortado_en ? ' <small>(cortado el ' + esc(fechaCorta(k.cortado_en)) + ')</small>' : ''}</td>
        <td>${esc(fechaCorta(k.cerrado_en))}</td><td>${esc(k.cerrado_por_nombre || '—')}</td><td>${esc(k.nota || '')}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<p class="vacio">Todavía no hay avisos cerrados.</p>'}`;
  enlazarCorte($('#ctCont'));
  $('#ctCont').querySelectorAll('[data-ficha-corte]').forEach(a => a.addEventListener('click', e => { if (!e.target.closest('button, input, label')) abrirFicha(a.dataset.fichaCorte); }));
}
$('#ctReglas').addEventListener('submit', async e => {
  e.preventDefault();
  const meses = Math.round(num($('#ctMeses').value)), dias = Math.round(num($('#ctDias').value)), rec = round2($('#ctReconexion').value);
  if (meses < 1 || meses > 24 || dias < 1 || dias > 90){ aviso('Revisa los valores: meses de 1 a 24 y días de 1 a 90.'); return; }
  if (!await tarea(sb.from('configuracion').update({meses_para_corte:meses, dias_aviso_corte:dias, monto_reconexion:rec, editado_por:CLIENTE_ID}).eq('id', 1), 'No se pudieron guardar las reglas')) return;
  Object.assign(state.settings, {mesesCorte:meses, diasAvisoCorte:dias, montoReconexion:rec});
  aviso('Reglas de corte guardadas.'); actualizarBadgeCortes(); capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'casa') aplicarEstilo(l); }); renderCobCortes();
});

/* ---------- Carga y cambios en vivo ---------- */
async function cargarCobros(){
  try { await sb.rpc('generar_cuotas', {p_forma:null}); } catch (e){ console.warn('generar_cuotas', e); }
  const [cob, pag, tar] = await Promise.all([
    Acu.traerTodo(sb, 'cobros').catch(e => { console.warn(e); return []; }),
    Acu.traerTodo(sb, 'pagos'),
    sb.from('tarifas').select('*').order('orden').order('nombre')
  ]);
  cobrosDe.clear(); pagosDe.clear();
  cob.forEach(c => ponerMovimiento(cobrosDe, c));
  await Promise.all([cargarArreglos(), cargarCortes()]);
  cobrosListos = true;
  pag.forEach(p => ponerMovimiento(pagosDe, p));
  if (!tar.error) tarifas = tar.data || [];
  await cargarCategorias();
}
async function recargarCobrosDe(id){
  const {data} = await sb.from('cobros').select('*').eq('forma_id', id);
  if (data){ cobrosDe.set(id, data); }
  refrescarCobrosUI(id);
}
function movimientoEnVivo(mapa, p){
  let forma;
  if (p.eventType === 'DELETE') forma = quitarMovimiento(mapa, p.old.id);
  else { ponerMovimiento(mapa, p.new); forma = p.new.forma_id; }
  if (forma) refrescarCobrosUI(forma);
}
function refrescarCobrosUI(id){
  revisarAvisosPronto();
  const l = capas.get(id);
  if (l){ refrescarForma(l); if (selected === l) refrescarCuenta(); }
  if (fichaId === id && $('#dlgFicha').open) renderFicha();
  if (/^cobros\/|^inicio$|^resumen$/.test(vistaActual || '')) renderVistaPronto();
}
const renderVistaPronto = debounce(() => renderVistaActual(), 250);
async function cargarTarifas(){
  const {data} = await sb.from('tarifas').select('*').order('orden').order('nombre');
  if (data){ tarifas = data; capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'casa') refrescarForma(l); }); renderVistaPronto(); if ($('#dlgFicha').open) renderFicha(); }
}

/* =====================================================================
   FICHA DE LA CASA (ventana central)
   ===================================================================== */
let fichaId = null, fichaTab = 'cuenta', fichaExtraAbierto = false;
function abrirFicha(id, tab){
  const l = capas.get(id);
  if (!l || l.aq.tipo !== 'casa'){ aviso('Esa casa ya no existe en el mapa.'); return; }
  fichaId = id; fichaTab = tab || 'cuenta'; fichaExtraAbierto = false;
  renderFicha();
  if (!$('#dlgFicha').open) $('#dlgFicha').showModal();
}
function renderFicha(){
  const l = capas.get(fichaId); if (!l){ $('#dlgFicha').close(); return; }
  const aq = l.aq, d = aq.datos, c = cuenta(aq), est = textoEstado(c);
  $('#fcTitulo').textContent = nombreCasa(d);
  $('#fcSub').innerHTML = `${esc(d.responsable || 'Sin representante registrado')}${d.telefono ? ' · ' + telLink(d.telefono) : ''}
    · ${nucleosDe(d)} ${nucleosDe(d) === 1 ? 'núcleo' : 'núcleos'}, ${personasDe(d)} ${personasDe(d) === 1 ? 'persona' : 'personas'}`;
  $('#fcSaldo').innerHTML = `<span>${c.saldo < 0 ? 'Saldo a favor' : 'Saldo'}</span><b class="${c.saldo > 0 ? 'debe' : ''}">${esc(dinero(Math.abs(c.saldo)))}</b><span class="fila">${etiquetaClase(clasificar(aq, c))}<span class="pill ${est.cls}">${esc(est.txt)}</span></span>`;
  document.querySelectorAll('[data-fc-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.fcTab === fichaTab)));
  const cuerpo = $('#fcCuerpo');
  cuerpo.innerHTML = ({cuenta:fichaCuenta, pago:fichaPago, nucleos:fichaNucleos, datos:fichaDatos})[fichaTab](aq, c);
  ({cuenta:enlazarCuenta, pago:enlazarPago, nucleos:enlazarNucleos, datos:enlazarDatos})[fichaTab](aq, c, cuerpo);
}
document.querySelectorAll('[data-fc-tab]').forEach(b => b.addEventListener('click', () => { fichaTab = b.dataset.fcTab; renderFicha(); }));
$('#fcMapa').addEventListener('click', () => { const l = capas.get(fichaId); $('#dlgFicha').close(); if (l){ location.hash = '#/mapa'; asegurarMapa(); enfocar(l); seleccionar(l); } });

/* --- Estado de cuenta --- */
function fichaCuenta(aq, c){
  const d = aq.datos, pend = c.pendientes, hasta = cubreHasta(aq, c);
  const aviso0 = !d.inicioCobro && !c.aplica
    ? `<div class="fc-aviso">Esta casa todavía no genera cuotas. Ve a <button class="enlace" data-ir-tab="datos">Datos y tarifa</button> e indica desde qué mes se cobra.</div>` : '';
  const movs = [
    ...(cobrosDe.get(aq.id) || []).map(x => ({...x, _tipo:'cargo'})),
    ...(pagosDe.get(aq.id) || []).map(x => ({...x, _tipo:'pago'}))
  ].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || (a._tipo === b._tipo ? ordenCargo(a, b) : a._tipo === 'cargo' ? -1 : 1));
  let saldo = 0;
  const filas = movs.map(m => {
    if (!m.anulado) saldo = round2(saldo + (m._tipo === 'cargo' ? num(m.monto) : -num(m.monto)));
    const concepto = m._tipo === 'cargo'
      ? esc(m.concepto) + (m.tipo === 'extra' && m.creado_por_nombre ? `<small>Agregado por ${esc(m.creado_por_nombre)}</small>` : '')
      : `Pago ${esc(numRecibo(m.recibo))} · ${esc(METODOS[m.metodo] || m.metodo || '')}${m.referencia ? ' · ref. ' + esc(m.referencia) : ''}${m.nota ? `<small>${esc(m.nota)}</small>` : ''}${m.registrado_por_nombre ? `<small>Recibió: ${esc(m.registrado_por_nombre)}</small>` : ''}`;
    return `<tr class="${m.anulado ? 'anulado' : ''} ${m._tipo}">
      <td>${esc(m.periodo && m.tipo === 'cuota' ? nombreMes(m.periodo, true) : fechaCorta(m.fecha))}</td>
      <td>${concepto}${m.anulado ? `<small class="motivo">Anulado por ${esc(m.anulado_por_nombre || '—')}: ${esc(m.motivo_anulacion || '')}</small>` : ''}</td>
      <td class="num">${m._tipo === 'cargo' ? esc(dinero(m.monto)) : ''}</td>
      <td class="num abono">${m._tipo === 'pago' ? esc(dinero(m.monto)) : ''}</td>
      <td class="num">${m.anulado ? '' : esc(dinero(saldo))}</td>
      <td class="acc">${m._tipo === 'pago' ? `<button class="btn chico" data-recibo="${esc(m.id)}">Recibo</button>` : ''}
        ${m.anulado ? '' : `<button class="btn chico" data-anular="${m._tipo}:${esc(m.id)}">Anular</button>`}</td></tr>`;
  }).reverse();
  return `${aviso0}
    ${accionesCorte(aq, c)}
    <div class="fc-kpis">
      <div><span>Cuota mensual</span><b>${esc(dinero(c.cuotaMes))}</b><small>${esc(textoCuota(c.cuota))}${c.exonerada ? ' · exonerada' : ''}</small></div>
      <div><span>Meses de atraso</span><b class="${c.atraso >= 3 ? 'rojo' : ''}">${c.atraso}</b><small>${c.atraso ? 'Cuotas vencidas sin pagar' : 'Ninguno'}</small></div>
      <div><span>Último pago</span><b>${c.ultimoPago ? esc(dinero(c.ultimoPago.monto)) : '—'}</b><small>${c.ultimoPago ? esc(fechaCorta(c.ultimoPago.fecha)) : 'Sin pagos'}</small></div>
      <div><span>${c.saldo > 0 ? 'Pendiente' : 'Cubierto hasta'}</span><b>${c.saldo > 0 ? pend.length : (hasta ? esc(nombreMes(hasta, true)) : '—')}</b>
        <small>${c.saldo > 0 ? (pend.length === 1 ? 'cargo por pagar' : 'cargos por pagar') : 'con lo ya pagado'}</small></div>
    </div>
    ${c.saldo < 0 && c.cuotaMes > 0 ? (() => { const m = mesesAdelantados(aq, -c.saldo, c.cuotaMes);
        return `<div class="fc-aviso info">💚 <b>Pagos adelantados:</b> ${m.length ? `cubre ${m.length} ${m.length === 1 ? 'mes' : 'meses'} (${esc(m.map(x => nombreMes(x, true)).join(', '))})` : 'tiene saldo a favor'}${round2(-c.saldo - m.length * c.cuotaMes) > 0 ? ` y le sobran ${esc(dinero(round2(-c.saldo - m.length * c.cuotaMes)))}` : ''}. Cada mes la cuota se descuenta sola con el valor de su tarifa.</div>`; })() : ''}
    ${fichaArreglo(aq, c)}
    ${pend.length ? `<div class="fc-pendiente"><b>Por pagar:</b> ${pend.slice(0, 8).map(x => `<span class="chip">${esc(x.tipo === 'cuota' ? nombreMes(x.periodo, true) : x.concepto)} · ${esc(dinero(x.falta))}</span>`).join('')}${pend.length > 8 ? ` <span class="chip">y ${pend.length - 8} más</span>` : ''}</div>` : ''}
    <div class="fila fc-acciones">
      <button class="btn primario" data-ir-tab="pago">Registrar pago</button>
      <button class="btn" id="fcExtraBtn">${fichaExtraAbierto ? 'Cancelar cargo' : 'Agregar cargo extra'}</button>
      <button class="btn" id="fcImprimir">Imprimir estado de cuenta</button>
    </div>
    <form class="fc-extra" id="fcExtra" ${fichaExtraAbierto ? '' : 'hidden'}>
      <label class="campo"><span>Concepto</span><select name="concepto">${CONCEPTOS_EXTRA.map(x => `<option>${x}</option>`).join('')}</select></label>
      <label class="campo"><span>Detalle (opcional)</span><input name="detalle" maxlength="80" placeholder="Ej. conexión sin permiso"></label>
      <label class="campo"><span>Monto</span><input name="monto" type="number" min="0.01" step="0.01" required></label>
      <label class="campo"><span>Fecha</span><input name="fecha" type="date" value="${hoyISO()}"></label>
      <div class="fila"><button class="btn primario" type="submit">Agregar cargo</button></div>
    </form>
    <h3 class="fc-sub">Movimientos</h3>
    ${filas.length ? `<div class="tabla-cont"><table class="tabla libreta">
      <thead><tr><th>Fecha</th><th>Concepto</th><th class="num">Cargo</th><th class="num">Abono</th><th class="num">Saldo</th><th></th></tr></thead>
      <tbody>${filas.join('')}</tbody></table></div>` : '<p class="vacio">Todavía no hay movimientos.</p>'}`;
}
let arregloFormAbierto = false;
function fichaArreglo(aq, c){
  const a = c.arreglo, previos = (arreglosDe.get(aq.id) || []).filter(x => x.estado !== 'vigente');
  const hist = previos.length ? `<p class="nota">Arreglos anteriores: ${previos.map(x => `${esc(dinero(x.deuda))} en ${x.cuotas} cuotas (${x.estado === 'cumplido' ? 'cumplido' : 'cancelado'})`).join(' · ')}</p>` : '';
  if (a){
    const av = c.avance, pct = Math.round(av.avance / num(a.deuda) * 100);
    return `<section class="arreglo ${av.atrasado ? 'atrasado' : ''}">
      <header><b>🤝 Arreglo de pago vigente</b><span class="pill ${av.atrasado ? 'bad' : 'ok'}">${av.atrasado ? 'Atrasado' : 'Al día'}</span></header>
      <p>Deuda acordada <b>${esc(dinero(a.deuda))}</b> en <b>${a.cuotas}</b> cuotas de <b>${esc(dinero(a.monto_cuota))}</b>, desde ${esc(nombreMes(String(a.inicio).slice(0, 7)))}. Además debe pagar la cuota mensual normal.</p>
      <div class="progreso"><i style="width:${pct}%"></i></div>
      <p class="nota">Avance: ${esc(dinero(av.avance))} de ${esc(dinero(a.deuda))} · ${av.cubiertas} de ${a.cuotas} cuotas${av.proxima ? ` · próxima: ${esc(nombreMes(av.proxima))}` : ' · completado'}${a.nota ? ' · ' + esc(a.nota) : ''}${a.creado_por_nombre ? ' · acordado con ' + esc(a.creado_por_nombre) : ''}</p>
      <div class="fila"><button class="btn chico" data-arreglo="cumplido">Marcar cumplido</button><button class="btn chico peligro" data-arreglo="cancelado">Cancelar arreglo</button></div>
      ${hist}</section>`;
  }
  if (c.saldo <= 0) return hist;
  const n = 6, sugerido = round2(c.saldo / n);
  return `<div class="fila"><button class="btn chico" id="arrNuevoBtn">${arregloFormAbierto ? 'Cancelar' : '🤝 Crear arreglo de pago'}</button></div>
    <form class="fc-extra" id="arrForm" ${arregloFormAbierto ? '' : 'hidden'}>
      <label class="campo"><span>Deuda acordada</span><input name="deuda" type="number" min="0.01" step="0.01" value="${c.saldo.toFixed(2)}"></label>
      <label class="campo"><span>Número de cuotas</span><input name="cuotas" type="number" min="1" max="60" step="1" value="${n}"></label>
      <label class="campo"><span>Monto de cada cuota</span><input name="monto_cuota" type="number" min="0.01" step="0.01" value="${sugerido.toFixed(2)}"></label>
      <label class="campo"><span>Primera cuota</span><input name="inicio" type="month" value="${sumarMeses(mesActual(), 1)}"></label>
      <label class="campo" style="grid-column:1/-1"><span>Nota (opcional)</span><input name="nota" maxlength="500" placeholder="Ej. acordado en reunión de junta del 10 de octubre"></label>
      <div class="fila"><button class="btn primario" type="submit">Guardar arreglo</button></div>
    </form>${hist}`;
}
function enlazarArreglo(aq, c, cuerpo){
  if ($('#arrNuevoBtn')) $('#arrNuevoBtn').addEventListener('click', () => { arregloFormAbierto = !arregloFormAbierto; renderFicha(); });
  const f = $('#arrForm');
  if (f){
    const recalc = () => { const d = num(f.deuda.value), n = Math.max(1, Math.round(num(f.cuotas.value))); f.monto_cuota.value = round2(d / n).toFixed(2); };
    f.deuda.addEventListener('input', recalc); f.cuotas.addEventListener('input', recalc);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const deuda = round2(f.deuda.value), cuotas = Math.round(num(f.cuotas.value)), monto = round2(f.monto_cuota.value);
      if (deuda <= 0 || cuotas < 1 || monto <= 0){ aviso('Revisa la deuda, el número de cuotas y el monto.'); return; }
      const fila = await consultaConFila(sb.from('arreglos_pago').insert({forma_id:aq.id, estado:'vigente', deuda, cuotas, monto_cuota:monto,
        inicio:(f.inicio.value || mesActual()) + '-01', nota:f.nota.value.trim() || null}).select().single(), 'No se pudo guardar el arreglo');
      if (!fila) return;
      if (!arreglosDe.has(aq.id)) arreglosDe.set(aq.id, []);
      arreglosDe.get(aq.id).push(fila); arregloFormAbierto = false;
      aviso('Arreglo de pago guardado.'); refrescarCobrosUI(aq.id);
    });
  }
  cuerpo.querySelectorAll('[data-arreglo]').forEach(b => b.addEventListener('click', async () => {
    const estado = b.dataset.arreglo;
    if (!confirm(estado === 'cumplido' ? '¿Marcar el arreglo como cumplido?' : '¿Cancelar el arreglo de pago? La deuda sigue pendiente.')) return;
    const fila = await consultaConFila(sb.from('arreglos_pago').update({estado}).eq('id', c.arreglo.id).select().single(), 'No se pudo actualizar el arreglo');
    if (!fila) return;
    const l = arreglosDe.get(aq.id), i = l.findIndex(x => x.id === fila.id); if (i >= 0) l[i] = fila;
    aviso(estado === 'cumplido' ? 'Arreglo cumplido.' : 'Arreglo cancelado.'); refrescarCobrosUI(aq.id);
  }));
}
function enlazarCuenta(aq, c, cuerpo){
  enlazarArreglo(aq, c, cuerpo);
  enlazarCorte(cuerpo);
  cuerpo.querySelectorAll('[data-ir-tab]').forEach(b => b.addEventListener('click', () => { fichaTab = b.dataset.irTab; renderFicha(); }));
  $('#fcExtraBtn').addEventListener('click', () => { fichaExtraAbierto = !fichaExtraAbierto; renderFicha(); });
  $('#fcImprimir').addEventListener('click', () => imprimirEstadoCuenta(aq));
  $('#fcExtra').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries()), monto = round2(f.monto);
    if (monto <= 0){ aviso('Escribe un monto mayor que cero.'); return; }
    const concepto = f.concepto + (f.detalle.trim() ? ': ' + f.detalle.trim() : '');
    const fila = await consultaConFila(sb.from('cobros').insert({forma_id:aq.id, tipo:'extra', concepto, monto, fecha:f.fecha || hoyISO()}).select().single(), 'No se pudo agregar el cargo');
    if (!fila) return;
    ponerMovimiento(cobrosDe, fila); fichaExtraAbierto = false;
    aviso('Cargo agregado: ' + concepto + ' · ' + dinero(monto));
    refrescarCobrosUI(aq.id);
  });
  cuerpo.querySelectorAll('[data-recibo]').forEach(b => b.addEventListener('click', () => mostrarRecibo(b.dataset.recibo)));
  cuerpo.querySelectorAll('[data-anular]').forEach(b => b.addEventListener('click', async () => {
    const [tipo, id] = b.dataset.anular.split(':');
    const lista = (tipo === 'pago' ? pagosDe : cobrosDe).get(aq.id) || [], m = lista.find(x => x.id === id); if (!m) return;
    const que = tipo === 'pago' ? `el pago ${numRecibo(m.recibo)} de ${dinero(m.monto)}` : `el cargo «${m.concepto}» de ${dinero(m.monto)}`;
    const motivo = prompt(`¿Por qué se anula ${que}?\nQueda registrado quién lo anuló y el motivo. No se puede deshacer.`, '');
    if (motivo === null) return;
    if (!motivo.trim()){ aviso('Escribe el motivo de la anulación.'); return; }
    const fila = await consultaConFila(sb.from(tipo === 'pago' ? 'pagos' : 'cobros').update({anulado:true, motivo_anulacion:motivo.trim()}).eq('id', id).select().single(), 'No se pudo anular');
    if (!fila) return;
    ponerMovimiento(tipo === 'pago' ? pagosDe : cobrosDe, fila);
    aviso('Movimiento anulado.');
    refrescarCobrosUI(aq.id);
  }));
}

/* --- Registrar pago --- */
let pagoMetodo = 'efectivo';
function fichaPago(aq, c){
  const cuota = c.cuotaMes, saldo = Math.max(0, c.saldo);
  const chips = [];
  if (saldo > 0) chips.push([saldo, `Todo el saldo · ${dinero(saldo)}`]);
  if (c.pendientes.length && c.pendientes[0].falta !== saldo) chips.push([c.pendientes[0].falta, `Lo más antiguo · ${dinero(c.pendientes[0].falta)}`]);
  if (cuota > 0) [1, 3, 6, 12].forEach(n => chips.push([round2(cuota * n), `${n} ${n === 1 ? 'mes' : 'meses'} · ${dinero(cuota * n)}`]));
  return `<div class="fc-pago">
    <div>
      <label class="campo"><span>Monto recibido (${esc(state.settings.moneda || '')})</span>
        <input type="number" id="pgMonto" class="monto-grande" min="0.01" step="0.01" value="${saldo > 0 ? saldo.toFixed(2) : cuota ? cuota.toFixed(2) : ''}"></label>
      <div class="chips">${chips.map(([v, t]) => `<button type="button" class="chip-btn" data-monto="${v.toFixed(2)}">${esc(t)}</button>`).join('')}</div>
      <label class="campo"><span>Forma de pago</span></label>
      <div class="segmento" role="group" aria-label="Forma de pago">${Object.entries(METODOS).map(([k, v]) => `<button type="button" data-metodo="${k}" class="${k === pagoMetodo ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="dos">
        <label class="campo"><span>Fecha del pago</span><input type="date" id="pgFecha" value="${hoyISO()}"></label>
        <label class="campo" id="pgRefBox" ${pagoMetodo === 'efectivo' ? 'hidden' : ''}><span>Referencia o N.º de comprobante</span><input type="text" id="pgRef" maxlength="60"></label>
      </div>
      <label class="campo"><span>Nota (opcional)</span><input type="text" id="pgNota" maxlength="200" placeholder="Ej. pagó su hija"></label>
      <button class="btn primario grande" id="pgGuardar">Registrar pago y ver recibo</button>
    </div>
    <aside class="fc-previa" id="pgPrevia"></aside>
  </div>`;
}
function previaPago(aq, c){
  const m = round2($('#pgMonto').value), despues = round2(c.saldo - m);
  let resto = m; const cubre = [];
  c.pendientes.forEach(p => { if (resto <= 0) return; const aplica = Math.min(resto, p.falta); resto = round2(resto - aplica);
    cubre.push(`${p.tipo === 'cuota' ? nombreMes(p.periodo, true) : p.concepto}${aplica < p.falta ? ' (parcial)' : ''}`); });
  const adelantoMeses = despues < 0 ? mesesAdelantados(aq, -despues, c.cuotaMes) : [], adelanto = adelantoMeses.length;
  $('#pgPrevia').innerHTML = m > 0 ? `
    <h4>Con este pago</h4>
    <p>Saldo actual: <b>${esc(dinero(c.saldo))}</b></p>
    <p>Pago: <b class="abono">− ${esc(dinero(m))}</b></p>
    <p class="resultado ${despues > 0 ? 'debe' : 'ok'}">${despues > 0 ? `Seguirá debiendo <b>${esc(dinero(despues))}</b>` : despues === 0 ? '<b>Queda al día</b>' : `Queda con <b>${esc(dinero(-despues))}</b> a favor`}</p>
    ${cubre.length ? `<p class="nota">Cubre: ${esc(cubre.join(', '))}</p>` : ''}
    ${adelanto ? `<p class="nota">Adelanta ${adelanto} ${adelanto === 1 ? 'mes' : 'meses'}: ${esc(adelantoMeses.map(x => nombreMes(x, true)).join(', '))}. Se descontarán solos cada mes con el valor de su tarifa (${esc(dinero(c.cuotaMes))}).</p>` : ''}`
    : '<p class="nota">Escribe el monto recibido para ver cómo queda la cuenta.</p>';
}
function enlazarPago(aq, c, cuerpo){
  const actualizar = () => previaPago(aq, c);
  $('#pgMonto').addEventListener('input', actualizar);
  cuerpo.querySelectorAll('[data-monto]').forEach(b => b.addEventListener('click', () => { $('#pgMonto').value = b.dataset.monto; actualizar(); }));
  cuerpo.querySelectorAll('[data-metodo]').forEach(b => b.addEventListener('click', () => {
    pagoMetodo = b.dataset.metodo;
    cuerpo.querySelectorAll('[data-metodo]').forEach(x => x.classList.toggle('on', x === b));
    $('#pgRefBox').hidden = pagoMetodo === 'efectivo';
  }));
  $('#pgGuardar').addEventListener('click', async () => {
    const monto = round2($('#pgMonto').value);
    if (monto <= 0){ aviso('Escribe un monto mayor que cero.'); $('#pgMonto').focus(); return; }
    if (!confirm(`¿Registrar un pago de ${dinero(monto)} (${METODOS[pagoMetodo]}) para ${nombreCasa(aq.datos)}?`)) return;
    const btn = $('#pgGuardar'); btn.disabled = true;
    const fila = await consultaConFila(sb.from('pagos').insert({id:uid(), forma_id:aq.id, fecha:$('#pgFecha').value || hoyISO(), monto,
      metodo:pagoMetodo, referencia:($('#pgRef').value || '').trim() || null, nota:$('#pgNota').value.trim() || null}).select().single(), 'No se pudo registrar el pago');
    btn.disabled = false;
    if (!fila) return;
    ponerMovimiento(pagosDe, fila);
    fichaTab = 'cuenta';
    refrescarCobrosUI(aq.id);
    mostrarRecibo(fila.id);
  });
  actualizar();
}

/* --- Núcleos familiares --- */
let nucleosEdicion = null;
function nucleosIniciales(d){
  if (Array.isArray(d.nucleosLista)) return d.nucleosLista.map(n => ({...n}));
  const n = Math.max(0, num(d.nucleos));
  return Array.from({length:n}, (_, i) => ({nombre:i === 0 ? (d.responsable || '') : '', personas:n === 1 ? (d.personas || '') : '', nota:''}));
}
function fichaNucleos(aq){
  const d = aq.datos, t = tarifaDe(d);
  if (!nucleosEdicion || nucleosEdicion.id !== aq.id) nucleosEdicion = {id:aq.id, lista:nucleosIniciales(d)};
  const lista = nucleosEdicion.lista, tot = lista.reduce((s, n) => s + Math.max(0, num(n.personas)), 0);
  const cobro = tieneEspecial(d) ? 'Esta casa tiene una cuota especial: el número de núcleos no cambia lo que paga.'
    : !t ? 'Esta casa no tiene tarifa asignada.'
    : t.modo === 'nucleo' ? `La tarifa «${t.nombre}» se cobra por núcleo: ${lista.length} × ${dinero(t.monto)} = <b>${dinero(lista.length * num(t.monto))}</b> al mes.`
    : t.modo === 'persona' ? `La tarifa «${t.nombre}» se cobra por persona: ${tot} × ${dinero(t.monto)} = <b>${dinero(tot * num(t.monto))}</b> al mes.`
    : `La tarifa «${t.nombre}» es un monto fijo por casa (${dinero(t.monto)}), sin importar los núcleos.`;
  return `<p class="nota" style="margin-top:0">Un núcleo familiar es cada familia u hogar que vive en la casa. Anota quién es el jefe o jefa de cada núcleo y cuántas personas lo forman.</p>
    <div class="fc-aviso info">${cobro}</div>
    <div class="tabla-cont"><table class="tabla nucleos">
      <thead><tr><th>#</th><th>Jefe o jefa del núcleo</th><th class="num">Personas</th><th>Nota</th><th></th></tr></thead>
      <tbody>${lista.map((n, i) => `<tr>
        <td>${i + 1}</td>
        <td><input data-n="${i}" data-c="nombre" value="${esc(n.nombre || '')}" maxlength="120" placeholder="Nombre completo"></td>
        <td class="num"><input data-n="${i}" data-c="personas" type="number" min="0" step="1" value="${esc(n.personas ?? '')}" class="corto"></td>
        <td><input data-n="${i}" data-c="nota" value="${esc(n.nota || '')}" maxlength="120" placeholder="Opcional"></td>
        <td><button class="btn chico peligro" data-quitar-n="${i}" aria-label="Quitar núcleo">Quitar</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="vacio">No hay núcleos registrados.</td></tr>'}</tbody>
      <tfoot><tr><td></td><td><b>${lista.length} ${lista.length === 1 ? 'núcleo' : 'núcleos'}</b></td><td class="num"><b>${tot}</b></td><td colspan="2"></td></tr></tfoot>
    </table></div>
    <div class="fila"><button class="btn" id="nAgregar">＋ Agregar núcleo</button><button class="btn primario" id="nGuardar">Guardar núcleos</button></div>
    <p class="nota">Al guardar, si la cuota mensual cambia, se ajusta la cuota de este mes. Los meses anteriores no cambian.</p>`;
}
function enlazarNucleos(aq, c, cuerpo){
  const ed = nucleosEdicion;
  cuerpo.classList.toggle('solo-lectura', !tienePermiso('editar_casas'));
  if (!tienePermiso('editar_casas')) cuerpo.querySelectorAll('input').forEach(el => { el.disabled = true; });
  cuerpo.querySelectorAll('[data-n]').forEach(inp => inp.addEventListener('input', () => { ed.lista[Number(inp.dataset.n)][inp.dataset.c] = inp.value; }));
  cuerpo.querySelectorAll('[data-quitar-n]').forEach(b => b.addEventListener('click', () => { ed.lista.splice(Number(b.dataset.quitarN), 1); renderFicha(); }));
  $('#nAgregar').addEventListener('click', () => { ed.lista.push({nombre:'', personas:'', nota:''}); renderFicha();
    const ins = cuerpo.querySelectorAll('[data-c="nombre"]'); if (ins.length) ins[ins.length - 1].focus(); });
  $('#nGuardar').addEventListener('click', async () => {
    const lista = ed.lista.map(n => ({nombre:String(n.nombre || '').trim(), personas:Math.max(0, Math.round(num(n.personas))), nota:String(n.nota || '').trim()}));
    const antes = cuotaMensual(aq.datos).monto;
    Object.assign(aq.datos, {nucleosLista:lista, nucleos:lista.length, personas:lista.reduce((s, n) => s + n.personas, 0)});
    await guardarDatosCobro(aq, antes, 'Núcleos guardados.');
    nucleosEdicion = null;
    renderFicha();
  });
}

/* --- Datos y tarifa --- */
function fichaDatos(aq, c){
  const d = aq.datos, q = cuotaMensual(d), activas = tarifas.filter(t => t.activa || t.id === d.tarifa);
  const vinculadas = usuariosDeCasa(aq.id).map(id => perfilesLista.find(p => p.id === id) || adminsLista.find(p => p.id === id)).filter(Boolean);
  const disponibles = perfilesLista.filter(p => p.rol === 'vecino' && p.estado === 'activo' && !vinculadas.some(v => v.id === p.id));
  return `<div class="dos-col">
    <section>
      <h3 class="fc-sub">Representante</h3>
      <label class="campo"><span>Número de casa</span><input id="fdNumero" value="${esc(d.numero || '')}" maxlength="20"></label>
      <label class="campo"><span>Representante legal de la casa</span><input id="fdResp" value="${esc(d.responsable || '')}" maxlength="120"></label>
      <label class="campo"><span>Teléfono</span><input id="fdTel" type="tel" value="${esc(d.telefono || '')}" maxlength="20"></label>
      <h3 class="fc-sub">Cuentas vinculadas</h3>
      <p class="nota" style="margin-top:0">Quienes tengan esta casa vinculada verán su estado de cuenta en su perfil del sitio.</p>
      <div class="vinculadas">${vinculadas.map(p => `<span class="chip-casa">${esc(p.nombre || p.email || 'Cuenta')}<button data-quitar-casa="${esc(p.id)}|${esc(aq.id)}" aria-label="Desvincular">×</button></span>`).join('') || '<span class="nota">Nadie tiene esta casa vinculada.</span>'}</div>
      ${disponibles.length ? `<select class="sel-chico" id="fdVincular"><option value="">＋ Vincular a un vecino…</option>${disponibles.map(p => `<option value="${esc(p.id)}">${esc(p.nombre || p.email)}${casasDeUsuario(p.id).length ? ' (ya tiene ' + casasDeUsuario(p.id).length + ')' : ''}</option>`).join('')}</select>` : ''}
    </section>
    <section>
      <h3 class="fc-sub">Cobro</h3>
      <label class="campo"><span>Categoría</span><select id="fdCategoria">${categorias.map(c => `<option value="${esc(c.id)}" ${c.id === (d.categoria || 'casa') ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></label>
      <label class="campo"><span>Tarifa</span><select id="fdTarifa">
        <option value="" ${!d.tarifa ? 'selected' : ''}>Según su categoría (${esc((tarifas.find(t => t.id === (categoriaDe(d) || {}).tarifa_id) || {}).nombre || 'tarifa general')})</option>
        ${activas.map(t => `<option value="${esc(t.id)}" ${t.id === d.tarifa ? 'selected' : ''}>${esc(t.nombre)} · ${esc(dinero(t.monto))} ${t.modo === 'nucleo' ? 'por núcleo' : t.modo === 'persona' ? 'por persona' : 'por casa'}</option>`).join('')}
      </select></label>
      <label class="campo"><span>Cuota especial (opcional)</span><input id="fdEspecial" type="number" min="0" step="0.01" value="${esc(tieneEspecial(d) ? d.cuotaEspecial : '')}" placeholder="Vacío: se usa la tarifa"></label>
      <label class="campo"><span>Cobrar desde</span><input id="fdInicio" type="month" value="${esc(d.inicioCobro || '')}"></label>
      <label class="campo"><span>Estado de cobro</span><select id="fdActivo">
        <option value="1" ${d.cobroActivo !== false ? 'selected' : ''}>Activo: genera una cuota cada mes</option>
        <option value="0" ${d.cobroActivo === false ? 'selected' : ''}>Exonerada: no genera cuotas nuevas</option></select></label>
      <label class="campo" id="fdMotivoBox" ${d.cobroActivo === false ? '' : 'hidden'}><span>Motivo de la exoneración</span><input id="fdMotivo" value="${esc(d.motivoExoneracion || '')}" maxlength="160" placeholder="Ej. casa deshabitada"></label>
      <div class="fc-aviso info" id="fdCuota">Cuota mensual actual: <b>${esc(dinero(q.monto))}</b> (${esc(textoCuota(q))}).</div>
    </section>
  </div>
  <div class="fila"><button class="btn primario" id="fdGuardar">Guardar cambios</button></div>
  <details class="fc-corregir">
    <summary>Corregir cuotas ya generadas</summary>
    <p class="nota">Las cuotas de meses pasados quedan fijas aunque cambies la tarifa. Si una tarifa estaba mal puesta, aplica la cuota actual (${esc(dinero(q.monto))}) a las cuotas desde un mes. Las anuladas no cambian.</p>
    <div class="fila"><input type="month" id="fdDesde" value="${mesActual()}"><button class="btn" id="fdRecalcular">Aplicar la cuota actual</button></div>
  </details>`;
}
function enlazarDatos(aq){
  const d = aq.datos;
  if (!tienePermiso('editar_casas')){ $('#fcCuerpo').classList.add('solo-lectura'); $('#fcCuerpo').querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; }); }
  else $('#fcCuerpo').classList.remove('solo-lectura');
  enlazarChipsCasas($('#fcCuerpo'));
  if ($('#fdVincular')) $('#fdVincular').addEventListener('change', e => { if (e.target.value) vincularCasa(e.target.value, aq.id); });
  const previa = () => {
    const tmp = {...d, categoria:$('#fdCategoria').value, tarifa:$('#fdTarifa').value, cuotaEspecial:$('#fdEspecial').value};
    const q = cuotaMensual(tmp);
    $('#fdCuota').innerHTML = `Cuota mensual con estos datos: <b>${esc(dinero(q.monto))}</b> (${esc(textoCuota(q))}).`;
  };
  ['#fdTarifa', '#fdEspecial', '#fdCategoria'].forEach(s => $(s).addEventListener('input', previa));
  $('#fdActivo').addEventListener('change', () => { $('#fdMotivoBox').hidden = $('#fdActivo').value === '1'; });
  $('#fdGuardar').addEventListener('click', async () => {
    const antes = cuotaMensual(d).monto;
    Object.assign(d, {numero:$('#fdNumero').value.trim(), responsable:$('#fdResp').value.trim(), telefono:$('#fdTel').value.trim(),
      categoria:$('#fdCategoria').value, tarifa:$('#fdTarifa').value, cuotaEspecial:$('#fdEspecial').value.trim(), inicioCobro:$('#fdInicio').value,
      cobroActivo:$('#fdActivo').value === '1', motivoExoneracion:$('#fdActivo').value === '1' ? '' : $('#fdMotivo').value.trim()});
    actualizarTooltip(capas.get(aq.id));
    await guardarDatosCobro(aq, antes, 'Datos guardados.');
    renderFicha();
  });
  $('#fdRecalcular').addEventListener('click', async () => {
    const desde = $('#fdDesde').value;
    if (!desde){ aviso('Elige desde qué mes.'); return; }
    if (!confirm(`¿Aplicar la cuota de ${dinero(cuotaMensual(d).monto)} a las cuotas desde ${nombreMes(desde)}?`)) return;
    await flush();
    const {data, error} = await sb.rpc('recalcular_cuotas', {p_forma:aq.id, p_desde:desde});
    if (error){ aviso(explicarError(error)); return; }
    aviso(data ? `${data} ${data === 1 ? 'cuota actualizada' : 'cuotas actualizadas'}.` : 'No había cuotas que cambiar.');
    recargarCobrosDe(aq.id);
  });
}
/* Guarda datos que afectan el cobro, genera cuotas faltantes y ajusta la del mes si cambió la cuota */
async function guardarDatosCobro(aq, cuotaAntes, msg){
  guardarForma(aq.id);
  await flush();
  const {error} = await sb.rpc('generar_cuotas', {p_forma:aq.id});
  if (error){ aviso(explicarError(error), 8000); return; }
  const ahora = cuotaMensual(aq.datos).monto;
  if (ahora !== cuotaAntes && aq.datos.inicioCobro && aq.datos.inicioCobro <= mesActual())
    await sb.rpc('recalcular_cuotas', {p_forma:aq.id, p_desde:mesActual()});
  await recargarCobrosDe(aq.id);
  refrescarForma(capas.get(aq.id));
  aviso(msg + (ahora !== cuotaAntes ? ` Cuota mensual: ${dinero(ahora)}.` : ''));
}

/* =====================================================================
   RECIBOS E IMPRESIÓN
   ===================================================================== */
function buscarPago(id){ for (const l of pagosDe.values()){ const p = l.find(x => x.id === id); if (p) return p; } return null; }
function datosRecibo(pagoId){
  const p = buscarPago(pagoId); if (!p) return null;
  const l = capas.get(p.forma_id), aq = l && l.aq;
  const antes = aq ? cuenta(aq, p.id) : null, despues = aq ? cuenta(aq) : null;
  let resto = num(p.monto); const cubre = [];
  if (antes) antes.pendientes.forEach(x => { if (resto <= 0) return; const a = Math.min(resto, x.falta); resto = round2(resto - a);
    cubre.push(`${x.tipo === 'cuota' ? nombreMes(x.periodo) : x.concepto}${a < x.falta ? ' (abono parcial)' : ''}`); });
  if (resto > 0.005 && aq){
    const c = cuenta(aq), favorPrevio = antes ? Math.max(0, -antes.saldo) : 0;
    const meses = mesesAdelantados(aq, favorPrevio + resto, c.cuotaMes).slice(Math.floor((favorPrevio + 0.005) / (c.cuotaMes || Infinity)));
    if (meses.length) cubre.push('Adelanto de ' + meses.map(x => nombreMes(x)).join(', '));
    const sobra = round2(resto - meses.length * c.cuotaMes);
    if (sobra > 0.005) cubre.push('Saldo a favor ' + dinero(sobra));
  } else if (resto > 0.005) cubre.push('Saldo a favor ' + dinero(resto));
  return {p, aq, cubre, saldoDespues:despues ? (p.anulado ? despues.saldo : despues.saldo) : null};
}
function htmlRecibo(r){
  const d = r.aq ? r.aq.datos : {};
  return `<div class="recibo">
    <div class="rc-cab"><div><b>${esc(state.settings.nombre || 'Acueducto')}</b><small>Comprobante de pago</small></div>
      <div class="rc-num">${esc(numRecibo(r.p.recibo))}</div></div>
    ${r.p.anulado ? `<div class="rc-anulado">ANULADO · ${esc(r.p.motivo_anulacion || '')}</div>` : ''}
    <dl>
      <dt>Fecha</dt><dd>${esc(fechaCorta(r.p.fecha))}</dd>
      <dt>Casa</dt><dd>${esc(r.aq ? nombreCasa(d) : 'Casa eliminada')}</dd>
      <dt>Representante</dt><dd>${esc(d.responsable || '—')}</dd>
      <dt>Forma de pago</dt><dd>${esc(METODOS[r.p.metodo] || r.p.metodo)}${r.p.referencia ? ' · ref. ' + esc(r.p.referencia) : ''}</dd>
      <dt>Aplicado a</dt><dd>${esc(r.cubre.join(', ') || 'Abono a cuenta')}</dd>
      ${r.p.nota ? `<dt>Nota</dt><dd>${esc(r.p.nota)}</dd>` : ''}
      <dt>Recibió</dt><dd>${esc(r.p.registrado_por_nombre || '—')}</dd>
    </dl>
    <div class="rc-monto"><span>Monto pagado</span><b>${esc(dinero(r.p.monto))}</b></div>
    ${r.saldoDespues != null ? `<p class="rc-saldo">Saldo de la cuenta hoy: <b>${esc(r.saldoDespues > 0 ? dinero(r.saldoDespues) : r.saldoDespues < 0 ? dinero(-r.saldoDespues) + ' a favor' : 'al día')}</b></p>` : ''}
  </div>`;
}
function mostrarRecibo(pagoId){
  const r = datosRecibo(pagoId); if (!r) return;
  $('#rcCuerpo').innerHTML = htmlRecibo(r);
  const tel = r.aq && numeroWhatsapp(r.aq.datos.telefono);
  const texto = `${state.settings.nombre || 'Acueducto'}: recibimos su pago ${numRecibo(r.p.recibo)} de ${dinero(r.p.monto)} el ${fechaCorta(r.p.fecha)} (${r.aq ? nombreCasa(r.aq.datos) : ''}). Aplicado a: ${r.cubre.join(', ') || 'abono a cuenta'}. ¡Gracias!`;
  $('#rcWhatsapp').hidden = !tel;
  if (tel) $('#rcWhatsapp').href = `https://wa.me/${tel}?text=${encodeURIComponent(texto)}`;
  $('#rcImprimir').onclick = () => imprimir(`Recibo ${numRecibo(r.p.recibo)}`, htmlRecibo(r));
  $('#dlgRecibo').showModal();
}
function imprimirEstadoCuenta(aq){
  const c = cuenta(aq), d = aq.datos;
  const movs = [...(cobrosDe.get(aq.id) || []).map(x => ({...x, _t:'c'})), ...(pagosDe.get(aq.id) || []).map(x => ({...x, _t:'p'}))]
    .filter(m => !m.anulado).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || (a._t === 'c' ? -1 : 1));
  let s = 0;
  const filas = movs.map(m => { s = round2(s + (m._t === 'c' ? num(m.monto) : -num(m.monto)));
    return `<tr><td>${esc(m._t === 'c' && m.tipo === 'cuota' ? nombreMes(m.periodo) : fechaCorta(m.fecha))}</td><td>${esc(m._t === 'c' ? m.concepto : 'Pago ' + numRecibo(m.recibo))}</td>
      <td class="n">${m._t === 'c' ? esc(dinero(m.monto)) : ''}</td><td class="n">${m._t === 'p' ? esc(dinero(m.monto)) : ''}</td><td class="n">${esc(dinero(s))}</td></tr>`; }).join('');
  imprimir(`Estado de cuenta ${nombreCasa(d)}`, `<div class="recibo ancho">
    <div class="rc-cab"><div><b>${esc(state.settings.nombre || 'Acueducto')}</b><small>Estado de cuenta al ${esc(fechaCorta(hoyISO()))}</small></div></div>
    <dl><dt>Casa</dt><dd>${esc(nombreCasa(d))}</dd><dt>Representante</dt><dd>${esc(d.responsable || '—')}</dd>
      <dt>Cuota mensual</dt><dd>${esc(dinero(c.cuotaMes))} (${esc(textoCuota(c.cuota))})</dd></dl>
    <table><thead><tr><th>Fecha</th><th>Concepto</th><th class="n">Cargo</th><th class="n">Abono</th><th class="n">Saldo</th></tr></thead><tbody>${filas}</tbody></table>
    <div class="rc-monto"><span>${c.saldo < 0 ? 'Saldo a favor' : 'Saldo pendiente'}</span><b>${esc(dinero(Math.abs(c.saldo)))}</b></div></div>`);
}
function imprimir(titulo, cuerpo){
  const v = window.open('', '_blank', 'width=720,height=900');
  if (!v){ aviso('Permite las ventanas emergentes para imprimir.'); return; }
  v.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>
    body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#15323B;margin:24px}
    .recibo{max-width:420px;margin:0 auto;border:1px solid #cfd8da;border-radius:10px;padding:18px}
    .recibo.ancho{max-width:720px}
    .rc-cab{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1D6FA3;padding-bottom:10px;margin-bottom:10px}
    .rc-cab b{font-size:18px;display:block}.rc-cab small{color:#5B7078}
    .rc-num{font-weight:700;font-size:16px;color:#1D6FA3}
    .rc-anulado{background:#FDECEA;color:#8C1D18;font-weight:700;padding:6px 8px;border-radius:6px;margin-bottom:8px}
    dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 12px;font-size:14px}dt{color:#5B7078}dd{margin:0}
    .rc-monto{display:flex;justify-content:space-between;align-items:center;background:#E1EEF6;border-radius:8px;padding:10px 12px;margin-top:10px}
    .rc-monto b{font-size:22px}.rc-saldo{font-size:13px;color:#5B7078}
    table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #e3e9eb}.n{text-align:right}
    @media print{body{margin:0}.recibo{border:0}}
  </style></head><body>${cuerpo}<script>window.onload=()=>{window.print();}<\/script></body></html>`);
  v.document.close();
}

/* =====================================================================
   SECCIONES DE COBROS
   ===================================================================== */
function filasCobro(){
  return datosGenerales().casas.map(l => ({l, d:l.aq.datos, c:cuenta(l.aq), q:cuotaMensual(l.aq.datos)}));
}
/* --- Resumen --- */
function renderCobResumen(){
  const mes = $('#crMes').value || mesActual();
  if (!$('#crMes').value) $('#crMes').value = mes;
  const filas = filasCobro();
  let porCobrar = 0, aFavor = 0, alDia = 0, deben = 0, morosas = 0, exoneradas = 0, sinCobro = 0;
  filas.forEach(x => {
    if (x.c.exonerada) exoneradas++;
    if (!x.c.aplica){ sinCobro++; return; }
    if (x.c.saldo > 0){ porCobrar += x.c.saldo; deben++; if (x.c.atraso >= 3) morosas++; }
    else { alDia++; if (x.c.saldo < 0) aFavor -= x.c.saldo; }
  });
  const pagos = todosLosPagos().filter(p => !p.anulado);
  const delMes = pagos.filter(p => String(p.fecha).startsWith(mes));
  const cobrado = round2(delMes.reduce((s, p) => s + num(p.monto), 0));
  const esperado = round2([...cobrosDe.values()].flat().filter(c => !c.anulado && c.tipo === 'cuota' && c.periodo === mes).reduce((s, c) => s + num(c.monto), 0));
  const porMetodo = {}; delMes.forEach(p => { porMetodo[p.metodo] = (porMetodo[p.metodo] || 0) + num(p.monto); });
  const meses = []; const [y0, m0] = mesActual().split('-').map(Number);
  for (let i = 5; i >= 0; i--){ const dd = new Date(y0, m0 - 1 - i, 1); meses.push(`${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`); }
  const serie = meses.map(k => [k, round2(pagos.filter(p => String(p.fecha).startsWith(k)).reduce((s, p) => s + num(p.monto), 0))]);
  const maxS = Math.max(1, ...serie.map(s => s[1])), maxM = Math.max(1, ...Object.values(porMetodo));
  const top = filas.filter(x => x.c.saldo > 0).sort((a, b) => b.c.saldo - a.c.saldo).slice(0, 8);
  const ultimos = pagos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || num(b.recibo) - num(a.recibo)).slice(0, 8);
  const pct = esperado ? Math.round(cobrado / esperado * 100) : null;
  $('#crCont').innerHTML = `
    <div class="kpis">
      ${kpiCob(dinero(porCobrar), 'Por cobrar', `${deben} ${deben === 1 ? 'casa debe' : 'casas deben'}`, porCobrar > 0 ? 'deuda' : 'ok')}
      ${kpiCob(dinero(cobrado), 'Cobrado en ' + nombreMes(mes, true), `${delMes.length} ${delMes.length === 1 ? 'pago' : 'pagos'}`)}
      ${kpiCob(pct == null ? '—' : pct + '%', 'Cumplimiento del mes', `Cuotas del mes: ${dinero(esperado)}`, pct != null && pct < 60 ? 'aviso' : '')}
      ${kpiCob(`${alDia} <span>de ${filas.length - sinCobro}</span>`, 'Casas al día', `${morosas} ${morosas === 1 ? 'morosa' : 'morosas'} (3 meses o más)`, morosas ? 'aviso' : 'ok')}
      ${kpiCob(dinero(aFavor), 'Saldo a favor', `${exoneradas} exoneradas · ${sinCobro} sin cobro`)}
    </div>
    <div class="rejilla">
      <article class="tarjeta"><header><h2>Casas con más deuda</h2><a href="#/cobros/casas">Ver todas</a></header>
        ${top.length ? `<ul class="lista">${top.map(x => { const e = textoEstado(x.c); return `<li><button class="item" data-ficha="${esc(x.l.aq.id)}">
          <span>${esc(nombreCasa(x.d))}<small>${esc(x.d.responsable || 'Sin representante')}</small></span><span class="pill ${e.cls}">${esc(e.txt)}</span></button></li>`; }).join('')}</ul>`
          : '<p class="vacio">✓ Ninguna casa tiene deuda.</p>'}</article>
      <article class="tarjeta"><header><h2>Últimos pagos</h2><a href="#/cobros/pagos">Ver pagos</a></header>
        ${ultimos.length ? `<ul class="lista">${ultimos.map(p => { const l = capas.get(p.forma_id); return `<li><button class="item" data-recibo="${esc(p.id)}">
          <span>${esc(l ? nombreCasa(l.aq.datos) : 'Casa eliminada')}<small>${esc(fechaCorta(p.fecha))} · ${esc(METODOS[p.metodo] || '')} · ${esc(numRecibo(p.recibo))}</small></span><b class="monto">${esc(dinero(p.monto))}</b></button></li>`; }).join('')}</ul>`
          : '<p class="vacio">Todavía no hay pagos.</p>'}</article>
      <article class="tarjeta"><header><h2>Cobrado por mes</h2></header>
        <div class="barras">${serie.map(([k, v]) => `<div class="barra-mes"><div class="relleno" style="height:${Math.round(v / maxS * 100)}%"></div><span>${esc(nombreMes(k, true))}</span><b>${esc(dinero(v))}</b></div>`).join('')}</div></article>
      <article class="tarjeta"><header><h2>Formas de pago en ${esc(nombreMes(mes, true))}</h2></header>
        ${Object.keys(porMetodo).length ? Object.entries(porMetodo).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="barra-h"><span>${esc(METODOS[k] || k)}</span><div><i style="width:${Math.round(v / maxM * 100)}%"></i></div><b>${esc(dinero(v))}</b></div>`).join('')
          : '<p class="vacio">No hubo pagos ese mes.</p>'}</article>
    </div>`;
  $('#crCont').querySelectorAll('[data-ficha]').forEach(b => b.addEventListener('click', () => abrirFicha(b.dataset.ficha)));
  $('#crCont').querySelectorAll('[data-recibo]').forEach(b => b.addEventListener('click', () => mostrarRecibo(b.dataset.recibo)));
}
const kpiCob = (v, t, s, cls = '') => `<div class="kpi ${cls}"><span class="kpi-t">${t}</span><b>${v}</b><small>${esc(s)}</small></div>`;
$('#crMes').addEventListener('change', renderCobResumen);
/* Registrar un pago: elegir la casa en una ventana */
function pintarElegirCasa(){
  const q = $('#ecBusca').value.trim().toLowerCase().replace(/^casa\s*/, '');
  const lista = filasCobro().filter(x => !q || String(x.d.numero || '').toLowerCase().startsWith(q) || String(x.d.responsable || '').toLowerCase().includes(q))
    .sort((a, b) => String(a.d.numero).localeCompare(String(b.d.numero), 'es', {numeric:true}));
  $('#ecLista').innerHTML = lista.length ? lista.slice(0, 60).map(x => { const e = textoEstado(x.c);
    return `<li><button data-elegir="${esc(x.l.aq.id)}"><span class="nom"><b>${esc(nombreCasa(x.d))}</b><small>${esc(x.d.responsable || 'Sin representante')}</small></span><span class="pill ${e.cls}">${esc(e.txt)}</span></button></li>`; }).join('')
    : '<li class="vacio" style="padding:12px">Ninguna casa coincide.</li>';
  $('#ecLista').querySelectorAll('[data-elegir]').forEach(b => b.addEventListener('click', () => { $('#dlgElegirCasa').close(); abrirFicha(b.dataset.elegir, 'pago'); }));
}
function abrirElegirCasa(){ if (!tienePermiso('registrar_pagos')) return; $('#ecBusca').value = ''; pintarElegirCasa(); $('#dlgElegirCasa').showModal(); setTimeout(() => $('#ecBusca').focus(), 0); }
$('#crRegistrar').addEventListener('click', abrirElegirCasa);
document.addEventListener('click', e => { if (e.target.closest('[data-accion-pago]')) abrirElegirCasa(); });
$('#ecBusca').addEventListener('input', pintarElegirCasa);
$('#ecBusca').addEventListener('keydown', e => { if (e.key === 'Enter'){ const b = $('#ecLista [data-elegir]'); if (b){ e.preventDefault(); b.click(); } } });
{ const dl = $('#dlgElegirCasa'); dl.querySelectorAll('[data-cerrar]').forEach(x => x.addEventListener('click', () => dl.close())); dl.addEventListener('click', e => { if (e.target === dl) dl.close(); }); }

/* --- Casas y cuentas --- */
let cobCasasFiltradas = [];
function renderCobCasas(){
  const sel = $('#ccTarifa'), prev = sel.value;
  sel.innerHTML = '<option value="">Todas las tarifas</option>' + tarifas.map(t => `<option value="${esc(t.id)}" ${t.id === prev ? 'selected' : ''}>${esc(t.nombre)}</option>`).join('');
  const q = $('#ccBusca').value.trim().toLowerCase(), f = $('#ccEstado').value, tf = sel.value;
  const todas = filasCobro();
  const lista = todas.filter(x => !q || [x.d.numero, x.d.responsable, x.d.telefono].join(' ').toLowerCase().includes(q))
    .filter(x => !tf || (x.d.tarifa || state.settings.tarifaDefecto) === tf)
    .filter(x => f === 'todas' || (f === 'deben' && x.c.saldo > 0) || (f === 'morosas' && x.c.atraso >= 3) || (f === 'aldia' && x.c.aplica && x.c.saldo <= 0)
      || (f === 'favor' && x.c.saldo < 0) || (f === 'exoneradas' && x.c.exonerada) || (f === 'sincobro' && !x.c.aplica)
      || (f === 'corte' && !!x.c.corte) || (f.startsWith('clase-') && clasificar(x.l.aq, x.c) === f.slice(6)))
    .sort((a, b) => b.c.saldo - a.c.saldo || String(a.d.numero).localeCompare(String(b.d.numero), 'es', {numeric:true}));
  cobCasasFiltradas = lista;
  const total = round2(lista.reduce((s, x) => s + Math.max(0, x.c.saldo), 0));
  $('#ccConteo').textContent = `${lista.length} de ${todas.length} casas · por cobrar ${dinero(total)}`;
  const cont = $('#ccTabla');
  if (!todas.length){ cont.innerHTML = `<div class="vacio-grande">Aún no hay casas.${esDev() ? ' <a href="#/mapa/dibujar/casa">Dibuja la primera en el mapa</a>.' : ''}</div>`; return; }
  if (!lista.length){ cont.innerHTML = '<div class="vacio-grande">Ninguna casa coincide con el filtro.</div>'; return; }
  cont.innerHTML = `<div class="tabla-cont"><table class="tabla clicable">
    <thead><tr><th>Casa</th><th>Representante</th><th class="num">Núcleos</th><th class="num">Personas</th><th>Tarifa</th><th class="num">Cuota</th><th>Último pago</th><th class="num">Saldo</th><th>Clasificación</th><th>Estado</th></tr></thead>
    <tbody>${lista.map(x => { const e = textoEstado(x.c); return `<tr data-ficha="${esc(x.l.aq.id)}" tabindex="0">
      <td><b>${esc(nombreCasa(x.d))}</b></td><td>${esc(x.d.responsable || '—')}</td>
      <td class="num">${nucleosDe(x.d)}</td><td class="num">${personasDe(x.d) || '—'}</td>
      <td>${esc(x.q.especial ? 'Especial' : (x.q.tarifa ? x.q.tarifa.nombre : '—'))}</td>
      <td class="num">${esc(dinero(x.q.monto))}</td>
      <td>${x.c.ultimoPago ? esc(fechaCorta(x.c.ultimoPago.fecha)) : '—'}</td>
      <td class="num"><b class="${x.c.saldo > 0 ? 'rojo' : ''}">${esc(dinero(x.c.saldo))}</b></td>
      <td>${etiquetaClase(clasificar(x.l.aq, x.c))}</td>
      <td><span class="pill ${e.cls}">${esc(e.txt)}</span></td></tr>`; }).join('')}</tbody></table></div>`;
  cont.querySelectorAll('[data-ficha]').forEach(tr => {
    tr.addEventListener('click', () => abrirFicha(tr.dataset.ficha));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') abrirFicha(tr.dataset.ficha); });
  });
}
['#ccBusca'].forEach(s => $(s).addEventListener('input', debounce(renderCobCasas, 200)));
['#ccEstado', '#ccTarifa'].forEach(s => $(s).addEventListener('change', renderCobCasas));
$('#ccCsv').addEventListener('click', () => {
  if (!cobCasasFiltradas.length){ aviso('No hay casas para exportar.'); return; }
  const enc = ['Casa','Representante','Teléfono','Núcleos','Personas','Tarifa','Cuota mensual','Total cargado','Total pagado','Saldo','Meses de atraso','Último pago','Estado'];
  const filas = cobCasasFiltradas.map(x => [x.d.numero, x.d.responsable, x.d.telefono, nucleosDe(x.d), personasDe(x.d),
    x.q.especial ? 'Especial' : (x.q.tarifa ? x.q.tarifa.nombre : ''), x.q.monto.toFixed(2), x.c.cargado.toFixed(2), x.c.pagado.toFixed(2),
    x.c.saldo.toFixed(2), x.c.atraso, x.c.ultimoPago ? x.c.ultimoPago.fecha : '', textoEstado(x.c).txt]);
  descargarCsv(enc, filas, `cuentas-${hoyISO()}.csv`);
});
function descargarCsv(enc, filas, nombre){
  const csv = [enc, ...filas].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  descargar('\ufeff' + csv, nombre, 'text/csv;charset=utf-8');
  aviso('Lista descargada. Se abre con Excel o Google Sheets.');
}

/* --- Pagos registrados --- */
let pagosFiltrados = [];
function renderCobPagos(){
  if (!$('#cpMes').value && !$('#cpMes').dataset.tocado) $('#cpMes').value = mesActual();
  const mes = $('#cpMes').value, met = $('#cpMetodo').value, anul = $('#cpAnulados').checked, q = $('#cpBusca').value.trim().toLowerCase();
  const lista = todosLosPagos().filter(p => (!mes || String(p.fecha).startsWith(mes)) && (!met || p.metodo === met) && (anul || !p.anulado))
    .filter(p => { if (!q) return true; const l = capas.get(p.forma_id), d = l ? l.aq.datos : {};
      return [d.numero, d.responsable, p.recibo, p.referencia, p.nota, p.registrado_por_nombre].join(' ').toLowerCase().includes(q); })
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || num(b.recibo) - num(a.recibo));
  pagosFiltrados = lista;
  const validos = lista.filter(p => !p.anulado), total = round2(validos.reduce((s, p) => s + num(p.monto), 0));
  const porMet = {}; validos.forEach(p => { porMet[p.metodo] = round2((porMet[p.metodo] || 0) + num(p.monto)); });
  $('#cpConteo').innerHTML = `${validos.length} ${validos.length === 1 ? 'pago' : 'pagos'} · <b>${esc(dinero(total))}</b>${Object.keys(porMet).length ? ' · ' + Object.entries(porMet).map(([k, v]) => `${esc(METODOS[k] || k)} ${esc(dinero(v))}`).join(' · ') : ''}`;
  const cont = $('#cpTabla');
  if (!lista.length){ cont.innerHTML = '<div class="vacio-grande">No hay pagos con estos filtros.</div>'; return; }
  cont.innerHTML = `<div class="tabla-cont"><table class="tabla clicable">
    <thead><tr><th>Recibo</th><th>Fecha</th><th>Casa</th><th>Representante</th><th>Forma de pago</th><th class="num">Monto</th><th>Recibió</th><th></th></tr></thead>
    <tbody>${lista.map(p => { const l = capas.get(p.forma_id), d = l ? l.aq.datos : {}; return `<tr class="${p.anulado ? 'anulado' : ''}" data-recibo="${esc(p.id)}" tabindex="0">
      <td><b>${esc(numRecibo(p.recibo))}</b></td><td>${esc(fechaCorta(p.fecha))}</td>
      <td>${l ? `<button class="enlace" data-ficha="${esc(p.forma_id)}">${esc(nombreCasa(d))}</button>` : 'Casa eliminada'}</td>
      <td>${esc(d.responsable || '—')}</td><td>${esc(METODOS[p.metodo] || p.metodo)}${p.referencia ? `<small> · ${esc(p.referencia)}</small>` : ''}</td>
      <td class="num"><b>${esc(dinero(p.monto))}</b></td><td>${esc(p.registrado_por_nombre || '—')}</td>
      <td>${p.anulado ? `<span class="pill bad" title="${esc(p.motivo_anulacion || '')}">Anulado</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
  cont.querySelectorAll('[data-ficha]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); abrirFicha(b.dataset.ficha); }));
  cont.querySelectorAll('tr[data-recibo]').forEach(tr => tr.addEventListener('click', () => mostrarRecibo(tr.dataset.recibo)));
}
$('#cpMes').addEventListener('change', () => { $('#cpMes').dataset.tocado = '1'; renderCobPagos(); });
['#cpMetodo', '#cpAnulados'].forEach(s => $(s).addEventListener('change', renderCobPagos));
$('#cpBusca').addEventListener('input', debounce(renderCobPagos, 200));
$('#cpTodos').addEventListener('click', () => { $('#cpMes').value = ''; $('#cpMes').dataset.tocado = '1'; renderCobPagos(); });
$('#cpCsv').addEventListener('click', () => {
  if (!pagosFiltrados.length){ aviso('No hay pagos para exportar.'); return; }
  descargarCsv(['Recibo','Fecha','Casa','Representante','Forma de pago','Referencia','Monto','Recibió','Nota','Anulado','Motivo de anulación'],
    pagosFiltrados.map(p => { const l = capas.get(p.forma_id), d = l ? l.aq.datos : {};
      return [p.recibo, p.fecha, d.numero || '', d.responsable || '', METODOS[p.metodo] || p.metodo, p.referencia || '', num(p.monto).toFixed(2),
        p.registrado_por_nombre || '', p.nota || '', p.anulado ? 'Sí' : 'No', p.motivo_anulacion || '']; }),
    `pagos-${$('#cpMes').value || 'todos'}.csv`);
});

/* --- Tarifas --- */
function renderCobTarifas(){
  renderCategorias();
  const casas = datosGenerales().casas;
  const uso = id => casas.filter(l => (tarifaDe(l.aq.datos) || {}).id === id && !tieneEspecial(l.aq.datos)).length;
  const especiales = casas.filter(l => tieneEspecial(l.aq.datos)).length;
  $('#ctLista').innerHTML = tarifas.map(t => `<article class="tarjeta tarifa ${t.activa ? '' : 'inactiva'}" data-tarifa="${esc(t.id)}">
      <div class="dos">
        <label class="campo"><span>Nombre</span><input data-t="nombre" value="${esc(t.nombre)}" maxlength="80"></label>
        <label class="campo"><span>Monto (${esc(state.settings.moneda || '')})</span><input data-t="monto" type="number" min="0" step="0.01" value="${esc(num(t.monto).toFixed(2))}"></label>
      </div>
      <label class="campo"><span>Cómo se cobra</span><select data-t="modo">${Object.entries(MODOS_TARIFA).map(([k, v]) => `<option value="${k}" ${k === t.modo ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="campo"><span>Descripción (opcional)</span><input data-t="descripcion" value="${esc(t.descripcion || '')}" maxlength="160"></label>
      <div class="fila">
        <label class="check"><input type="radio" name="tarifaDefecto" value="${esc(t.id)}" ${t.id === state.settings.tarifaDefecto ? 'checked' : ''}><span>Tarifa para casas nuevas</span></label>
        <label class="check"><input type="checkbox" data-t="activa" ${t.activa ? 'checked' : ''}><span>Disponible</span></label>
      </div>
      <p class="nota">${uso(t.id)} ${uso(t.id) === 1 ? 'casa usa' : 'casas usan'} esta tarifa.</p>
      <div class="fila"><button class="btn primario chico" data-guardar-tarifa>Guardar</button>
        ${uso(t.id) || t.id === state.settings.tarifaDefecto ? '' : '<button class="btn peligro chico" data-borrar-tarifa>Quitar</button>'}</div>
    </article>`).join('') + (especiales ? `<p class="nota">${especiales} ${especiales === 1 ? 'casa tiene' : 'casas tienen'} una cuota especial que no depende de la tarifa.</p>` : '');
  $('#ctLista').querySelectorAll('[data-tarifa]').forEach(card => {
    const id = card.dataset.tarifa, t = tarifas.find(x => x.id === id);
    card.querySelector('[data-guardar-tarifa]').addEventListener('click', async () => {
      const v = k => card.querySelector(`[data-t="${k}"]`);
      const cambios = {nombre:v('nombre').value.trim(), monto:round2(v('monto').value), modo:v('modo').value, descripcion:v('descripcion').value.trim() || null, activa:v('activa').checked};
      if (cambios.nombre.length < 2){ aviso('Escribe el nombre de la tarifa.'); return; }
      const cambiaCuota = cambios.monto !== round2(t.monto) || cambios.modo !== t.modo;
      if (!await tarea(sb.from('tarifas').update(cambios).eq('id', id), 'No se pudo guardar la tarifa')) return;
      Object.assign(t, cambios);
      if (cambiaCuota && uso(id) && confirm(`Tarifa guardada. Los meses pasados no cambian.\n\n¿Aplicar el nuevo monto también a la cuota de ${nombreMes(mesActual())} de las ${uso(id)} casas con esta tarifa?`)){
        const ids = casas.filter(l => (l.aq.datos.tarifa || state.settings.tarifaDefecto) === id && !tieneEspecial(l.aq.datos)).map(l => l.aq.id);
        for (const fid of ids) await sb.rpc('recalcular_cuotas', {p_forma:fid, p_desde:mesActual()});
        await cargarCobros();
      }
      aviso('Tarifa guardada.'); capa.eachLayer(l => { if (l.aq && l.aq.tipo === 'casa') refrescarForma(l); }); renderCobTarifas();
    });
    const borrar = card.querySelector('[data-borrar-tarifa]');
    if (borrar) borrar.addEventListener('click', async () => {
      if (!confirm(`¿Quitar la tarifa «${t.nombre}»?`)) return;
      if (await tarea(sb.from('tarifas').delete().eq('id', id), 'No se pudo quitar la tarifa')){ tarifas = tarifas.filter(x => x.id !== id); renderCobTarifas(); }
    });
  });
  $('#ctLista').querySelectorAll('input[name=tarifaDefecto]').forEach(r => r.addEventListener('change', async () => {
    if (await tarea(sb.from('configuracion').update({tarifa_defecto:r.value, editado_por:CLIENTE_ID}).eq('id', 1), 'No se pudo guardar')){
      state.settings.tarifaDefecto = r.value; aviso('Las casas nuevas usarán esta tarifa.'); renderCobTarifas();
    }
  }));
}
$('#ctNueva').addEventListener('submit', async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target).entries());
  if ((f.nombre || '').trim().length < 2){ aviso('Escribe el nombre de la tarifa.'); return; }
  const id = f.nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid();
  if (tarifas.some(t => t.id === id)){ aviso('Ya existe una tarifa con ese nombre.'); return; }
  const fila = await consultaConFila(sb.from('tarifas').insert({id, nombre:f.nombre.trim(), monto:round2(f.monto), modo:f.modo, orden:tarifas.length + 1}).select().single(), 'No se pudo crear la tarifa');
  if (fila){ tarifas.push(fila); e.target.reset(); aviso('Tarifa creada.'); renderCobTarifas(); }
});
$('#ctGenerar').addEventListener('click', async () => {
  const {data, error} = await sb.rpc('generar_cuotas', {p_forma:null});
  if (error){ aviso(explicarError(error)); return; }
  aviso(data ? `Se generaron ${data} ${data === 1 ? 'cuota' : 'cuotas'}.` : 'Todas las cuotas hasta este mes ya estaban generadas.');
  await cargarCobros(); renderVistaActual();
});

/* --- Historial de cobros: todo lo que se hizo, con fecha y hora, en páginas de 20 --- */
const POR_PAGINA = 20;
let histPagina = 1, histFiltrado = [];
const TIPO_EVENTO = {
  pago:{txt:'Pago registrado', cls:'ok', icono:'💵'}, pago_anulado:{txt:'Pago anulado', cls:'bad', icono:'⛔'},
  extra:{txt:'Cargo extra', cls:'warn', icono:'➕'}, saldo_inicial:{txt:'Deuda anterior', cls:'warn', icono:'📄'},
  cuota:{txt:'Cuota mensual', cls:'nada', icono:'📅'}, cargo_anulado:{txt:'Cargo anulado', cls:'bad', icono:'⛔'}
};
const cuandoISO = (ts, fecha) => ts || (fecha ? String(fecha).slice(0, 10) + 'T12:00:00' : '');
function eventosCobro(){
  const ev = [];
  todosLosPagos().forEach(p => {
    ev.push({tipo:'pago', cuando:cuandoISO(p.created_at, p.fecha), forma_id:p.forma_id, monto:num(p.monto), signo:-1, por:p.registrado_por_nombre,
      detalle:`Recibo ${numRecibo(p.recibo)} · ${METODOS[p.metodo] || p.metodo || ''}${p.referencia ? ' · ref. ' + p.referencia : ''}${p.fecha ? ' · fecha del pago ' + fechaCorta(p.fecha) : ''}${p.nota ? ' · ' + p.nota : ''}`,
      pagoId:p.id, anulado:p.anulado});
    if (p.anulado) ev.push({tipo:'pago_anulado', cuando:cuandoISO(p.anulado_en, p.fecha), forma_id:p.forma_id, monto:num(p.monto), signo:0,
      por:p.anulado_por_nombre, detalle:`Recibo ${numRecibo(p.recibo)} · motivo: ${p.motivo_anulacion || '—'}`, pagoId:p.id});
  });
  [...cobrosDe.values()].flat().forEach(c => {
    ev.push({tipo:c.tipo, cuando:cuandoISO(c.created_at, c.fecha), forma_id:c.forma_id, monto:num(c.monto), signo:1,
      por:c.creado_por_nombre || (c.tipo === 'cuota' ? 'Automático' : ''), detalle:c.concepto, anulado:c.anulado});
    if (c.anulado) ev.push({tipo:'cargo_anulado', cuando:cuandoISO(c.anulado_en, c.fecha), forma_id:c.forma_id, monto:num(c.monto), signo:0,
      por:c.anulado_por_nombre, detalle:`${c.concepto} · motivo: ${c.motivo_anulacion || '—'}`});
  });
  return ev.sort((a, b) => String(b.cuando).localeCompare(String(a.cuando)));
}
function fechaHoraEvento(iso){
  if (!iso) return {f:'—', h:''};
  const d = new Date(iso);
  return {f:d.toLocaleDateString('es', {day:'numeric', month:'short', year:'numeric'}), h:d.toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'})};
}
function renderCobHistorial(){
  const q = $('#chBusca').value.trim().toLowerCase().replace(/^casa\s*/, ''), tipo = $('#chTipo').value;
  const desde = $('#chDesde').value, hasta = $('#chHasta').value;
  const grupos = {todo:['pago','pago_anulado','extra','saldo_inicial','cargo_anulado'], pagos:['pago'], cargos:['extra','saldo_inicial'],
    cuotas:['cuota'], anulaciones:['pago_anulado','cargo_anulado'], completo:Object.keys(TIPO_EVENTO)};
  histFiltrado = eventosCobro().filter(e => grupos[tipo].includes(e.tipo))
    .filter(e => { const dia = String(e.cuando).slice(0, 10); return (!desde || dia >= desde) && (!hasta || dia <= hasta); })
    .filter(e => {
      if (!q) return true;
      const l = capas.get(e.forma_id), d = l ? l.aq.datos : {};
      const numero = String(d.numero || '').toLowerCase();
      return numero === q || numero.startsWith(q) || String(d.responsable || '').toLowerCase().includes(q) || String(e.por || '').toLowerCase().includes(q);
    });
  const total = histFiltrado.length, paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  histPagina = Math.min(Math.max(1, histPagina), paginas);
  const ini = (histPagina - 1) * POR_PAGINA, pagina = histFiltrado.slice(ini, ini + POR_PAGINA);
  const cobrado = round2(histFiltrado.filter(e => e.tipo === 'pago' && !e.anulado).reduce((s, e) => s + e.monto, 0));
  $('#chConteo').innerHTML = total
    ? `Mostrando <b>${ini + 1}–${ini + pagina.length}</b> de <b>${total}</b> ${total === 1 ? 'registro' : 'registros'}${cobrado ? ` · pagos válidos: <b>${esc(dinero(cobrado))}</b>` : ''}`
    : '';
  const cont = $('#chTabla');
  if (!total){ cont.innerHTML = '<div class="vacio-grande">No hay registros con estos filtros.</div>'; $('#chPaginas').innerHTML = ''; return; }
  cont.innerHTML = `<div class="tabla-cont"><table class="tabla clicable historial">
    <thead><tr><th>Fecha</th><th>Hora</th><th>Movimiento</th><th>Casa</th><th>Representante</th><th>Detalle</th><th class="num">Monto</th><th>Hecho por</th></tr></thead>
    <tbody>${pagina.map((e, i) => {
      const l = capas.get(e.forma_id), d = l ? l.aq.datos : {}, t = TIPO_EVENTO[e.tipo], fh = fechaHoraEvento(e.cuando);
      return `<tr data-i="${ini + i}" tabindex="0" class="${e.anulado ? 'anulado' : ''}">
        <td>${esc(fh.f)}</td><td class="hora">${esc(fh.h)}</td>
        <td><span class="pill ${t.cls}">${t.icono} ${t.txt}</span></td>
        <td><b>${esc(l ? nombreCasa(d) : 'Casa eliminada')}</b></td><td>${esc(d.responsable || '—')}</td>
        <td class="detalle">${esc(e.detalle || '')}</td>
        <td class="num ${e.signo < 0 ? 'abono' : ''}">${e.signo < 0 ? '− ' : e.signo > 0 ? '+ ' : ''}${esc(dinero(e.monto))}</td>
        <td>${esc(e.por || '—')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  cont.querySelectorAll('tr[data-i]').forEach(tr => {
    const abrir = () => { const e = histFiltrado[Number(tr.dataset.i)]; if (e.pagoId) mostrarRecibo(e.pagoId); else if (capas.get(e.forma_id)) abrirFicha(e.forma_id, 'cuenta'); };
    tr.addEventListener('click', abrir);
    tr.addEventListener('keydown', ev => { if (ev.key === 'Enter') abrir(); });
  });
  // Paginación: primera, anterior, números cercanos, siguiente, última
  const nums = [];
  for (let n = 1; n <= paginas; n++) if (n === 1 || n === paginas || Math.abs(n - histPagina) <= 2) nums.push(n);
  let html = `<button class="btn chico" data-pag="${histPagina - 1}" ${histPagina === 1 ? 'disabled' : ''}>‹ Anterior</button>`;
  nums.forEach((n, k) => {
    if (k && n - nums[k - 1] > 1) html += '<span class="puntos">…</span>';
    html += `<button class="btn chico ${n === histPagina ? 'on' : ''}" data-pag="${n}" ${n === histPagina ? 'aria-current="page"' : ''}>${n}</button>`;
  });
  html += `<button class="btn chico" data-pag="${histPagina + 1}" ${histPagina === paginas ? 'disabled' : ''}>Siguiente ›</button>
    <span class="nota">Página ${histPagina} de ${paginas}</span>`;
  $('#chPaginas').innerHTML = html;
  $('#chPaginas').querySelectorAll('[data-pag]').forEach(b => b.addEventListener('click', () => {
    histPagina = Number(b.dataset.pag); renderCobHistorial();
    $('#chTabla').scrollIntoView({block:'start', behavior:'smooth'});
  }));
}
const reiniciarHistorial = () => { histPagina = 1; renderCobHistorial(); };
$('#chBusca').addEventListener('input', debounce(reiniciarHistorial, 200));
['#chTipo', '#chDesde', '#chHasta'].forEach(s => $(s).addEventListener('change', reiniciarHistorial));
$('#chLimpiar').addEventListener('click', () => { $('#chBusca').value = ''; $('#chTipo').value = 'todo'; $('#chDesde').value = ''; $('#chHasta').value = ''; reiniciarHistorial(); });
$('#chCsv').addEventListener('click', () => {
  if (!histFiltrado.length){ aviso('No hay registros para exportar.'); return; }
  descargarCsv(['Fecha','Hora','Movimiento','Casa','Representante','Detalle','Monto','Hecho por'],
    histFiltrado.map(e => { const l = capas.get(e.forma_id), d = l ? l.aq.datos : {}, fh = fechaHoraEvento(e.cuando);
      return [String(e.cuando).slice(0, 10), fh.h, TIPO_EVENTO[e.tipo].txt + (e.anulado ? ' (anulado)' : ''), d.numero || '', d.responsable || '', e.detalle || '',
        (e.signo < 0 ? -e.monto : e.monto).toFixed(2), e.por || '']; }),
    `historial-cobros-${hoyISO()}.csv`);
});

/* Diálogos de cobros */
['#dlgFicha', '#dlgRecibo'].forEach(sel => {
  const dl = $(sel);
  dl.querySelectorAll('[data-cerrar]').forEach(x => x.addEventListener('click', () => dl.close()));
  dl.addEventListener('click', e => { if (e.target === dl) dl.close(); });
});
$('#dlgFicha').addEventListener('close', () => { nucleosEdicion = null; });

/* =====================================================================
   ALINEAR FONDO: mover un mapa de fondo hasta que coincida con lo dibujado
   ===================================================================== */
let ajusteEdicion = null;
const REFERENCIA_FONDO = 'Satélite (Esri)';
function abrirAlinear(){
  asegurarMapa();
  ajusteEdicion = map.ajustesFondos();
  $('#panelAlinear').hidden = false;
  pintarAlinear();
}
function pintarAlinear(){
  const f = map.fondoActual(), a = ajusteEdicion[f] || {este:0, norte:0};
  const signo = n => (n > 0 ? '+' : '') + (Math.round(n * 100) / 100) + ' m';
  $('#alFondo').textContent = f;
  $('#alValor').textContent = `Este: ${signo(a.este || 0)} · Norte: ${signo(a.norte || 0)}`;
  $('#alAviso').hidden = f !== REFERENCIA_FONDO;
}
function moverFondo(de, dn){
  const f = map.fondoActual(), paso = Number($('#alPaso').value);
  const a = ajusteEdicion[f] = ajusteEdicion[f] || {este:0, norte:0};
  a.este = Math.round(((a.este || 0) + de * paso) * 100) / 100;
  a.norte = Math.round(((a.norte || 0) + dn * paso) * 100) / 100;
  map.ajustarFondos(ajusteEdicion); pintarAlinear();
}
$('#alinearFondo').addEventListener('click', abrirAlinear);
document.querySelectorAll('[data-mover]').forEach(b => b.addEventListener('click', () => { const [e, n] = b.dataset.mover.split(',').map(Number); moverFondo(e, n); }));
$('#alRestablecer').addEventListener('click', () => { delete ajusteEdicion[map.fondoActual()]; map.ajustarFondos(ajusteEdicion); pintarAlinear(); });
$('#alCerrar').addEventListener('click', () => { map.ajustarFondos(state.settings.ajusteFondos || {}); $('#panelAlinear').hidden = true; ajusteEdicion = null; });
$('#alGuardar').addEventListener('click', async () => {
  const limpio = Object.fromEntries(Object.entries(ajusteEdicion).filter(([, a]) => a && (a.este || a.norte)));
  const ok = await tarea(sb.from('configuracion').update({ajuste_fondos:limpio, editado_por:CLIENTE_ID}).eq('id', 1), 'No se pudo guardar la alineación');
  if (!ok) return;
  state.settings.ajusteFondos = limpio;
  $('#panelAlinear').hidden = true; ajusteEdicion = null;
  aviso('Alineación guardada. También se aplica en el mapa público.', 5000);
});
map.on('baselayerchange', () => { if (ajusteEdicion) pintarAlinear(); });
document.addEventListener('keydown', e => {
  if (!ajusteEdicion || /input|select|textarea/i.test(document.activeElement.tagName)) return;
  const k = {ArrowLeft:[-1, 0], ArrowRight:[1, 0], ArrowUp:[0, 1], ArrowDown:[0, -1]}[e.key];
  if (k){ e.preventDefault(); moverFondo(...k); }
});

/* ---------- Política de privacidad (se edita aquí y se muestra en privacidad.html) ---------- */
let polEditada = false;
function pintarPolitica(){
  const f = state.settings.politicaFecha;
  $('#polFecha').textContent = state.settings.politica
    ? (f ? 'Última actualización: ' + new Date(f).toLocaleDateString('es', {day:'numeric', month:'long', year:'numeric'}) + ' a las ' + new Date(f).toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'}) : '')
    : 'Se muestra el texto base (aún no se ha guardado uno propio).';
  if (!polEditada) $('#polTexto').value = state.settings.politica || AcuPolitica.TEXTO_BASE;
}
function previaPolitica(){
  const r = AcuPolitica.render($('#polTexto').value, {acueducto:state.settings.nombre, correo:state.settings.correoContacto,
    whatsapp:state.settings.whatsappActivo ? state.settings.whatsapp : ''});
  $('#polPrevia').innerHTML = r.html || '<p class="vacio">El texto está vacío.</p>';
}
$('#polTexto').addEventListener('input', () => { polEditada = true; if (!$('#polPrevia').hidden) previaPolitica(); });
$('#polVista').addEventListener('click', () => {
  const ver = $('#polPrevia').hidden; $('#polPrevia').hidden = !ver;
  $('#polVista').textContent = ver ? 'Ocultar vista previa' : 'Vista previa';
  if (ver) previaPolitica();
});
$('#polBase').addEventListener('click', () => {
  if (!confirm('¿Reemplazar lo escrito por el texto base? No se publica hasta que guardes.')) return;
  $('#polTexto').value = AcuPolitica.TEXTO_BASE; polEditada = true; if (!$('#polPrevia').hidden) previaPolitica();
});
$('#polGuardar').addEventListener('click', async () => {
  const texto = $('#polTexto').value.trim();
  if (texto.length < 50){ aviso('El texto de la política es demasiado corto.'); return; }
  if (!confirm('¿Publicar esta política de privacidad? La fecha de actualización cambiará a hoy.')) return;
  const fila = await consultaConFila(sb.from('configuracion').update({politica_privacidad:texto, editado_por:CLIENTE_ID}).eq('id', 1)
    .select('politica_privacidad,politica_actualizada_en').single(), 'No se pudo guardar la política');
  if (!fila) return;
  state.settings.politica = fila.politica_privacidad; state.settings.politicaFecha = fila.politica_actualizada_en;
  polEditada = false; pintarPolitica();
  aviso('Política publicada. Los usuarios ya ven la nueva versión y su fecha.', 5000);
});

/* ================= Sección: Configuración ================= */
function cargarConfigEnFormulario(){
  $('#cfgNombre').value = state.settings.nombre;
  $('#cfgCuota').value = state.settings.cuota;
  const selMon = $('#cfgMoneda'), mon = limpiarMoneda(state.settings.moneda);
  if (![...selMon.options].some(o => o.value === mon)) selMon.add(new Option(mon, mon));
  selMon.value = mon;
  $('#cfgColorPago').checked = !!state.settings.colorPorPago;
  $('#cfgOcultarRed').checked = !!state.settings.ocultarRed;
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
  state.settings.moneda = limpiarMoneda($('#cfgMoneda').value);
  state.settings.colorPorPago = $('#cfgColorPago').checked;
  state.settings.ocultarRed = $('#cfgOcultarRed').checked;
  state.settings.whatsapp = $('#cfgWhatsapp').value.trim();
  state.settings.whatsappMensaje = $('#cfgWhatsappMsg').value;
  state.settings.whatsappActivo = $('#cfgWhatsappActivo').checked;
  state.settings.correoContacto = $('#cfgCorreo').value.trim();
  probarWhatsapp();
  capa.eachLayer(l => { if (l.aq){ aplicarEstilo(l); actualizarTooltip(l); } });
  if (selected){ actualizarTituloPanel(); refrescarCuenta(); }
  renderResumen(); guardarConfig();
}
['#cfgNombre','#cfgWhatsapp','#cfgWhatsappMsg','#cfgCorreo'].forEach(s => $(s).addEventListener('input', alCambiarConfig));
$('#cfgMoneda').addEventListener('change', alCambiarConfig);
$('#cfgWhatsappActivo').addEventListener('change', alCambiarConfig);
$('#cfgOcultarRed').addEventListener('change', () => { alCambiarConfig();
  aviso($('#cfgOcultarRed').checked ? 'Los vecinos ya no ven las tuberías, llaves ni conectores.' : 'Los vecinos vuelven a ver las tuberías, llaves y conectores.', 5000); });
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
  return {app:'mapa-acueducto', version:5, guardado:new Date().toISOString(), settings:state.settings,
    tiposIncidencia:tiposInc, incidencias:[...incidencias.values()],
    tarifas, cobros:[...cobrosDe.values()].flat(), pagos:todosLosPagos(),
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
  // Copias nuevas (versión 5): tarifas, cargos y pagos con su recibo
  if (Array.isArray(data.tarifas) && data.tarifas.length){
    const {error} = await sb.from('tarifas').upsert(data.tarifas.map(({created_at, updated_at, ...t}) => t)); if (error) throw error;
  }
  if (Array.isArray(data.pagos)) data.pagos.forEach(x => pagos.push({id:x.id, forma_id:x.forma_id, fecha:x.fecha, monto:num(x.monto), nota:x.nota || '',
    metodo:x.metodo || 'efectivo', referencia:x.referencia || null, ...(x.recibo ? {recibo:x.recibo} : {})}));
  for (let i = 0; i < pagos.length; i += 500){
    const {error} = await sb.from('pagos').upsert(pagos.slice(i, i + 500)); if (error) throw error;
  }
  if (Array.isArray(data.cobros) && data.cobros.length){
    const cob = data.cobros.map(x => ({id:x.id, forma_id:x.forma_id, tipo:x.tipo, periodo:x.periodo || null, concepto:x.concepto, monto:num(x.monto), fecha:x.fecha}));
    for (let i = 0; i < cob.length; i += 500){ const {error} = await sb.from('cobros').upsert(cob.slice(i, i + 500)); if (error) throw error; }
  }
  await sb.rpc('generar_cuotas', {p_forma:null});
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
  await AcuSesion.cerrar(sb, PAGINA_ACCESO);
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
    ['tarifas', 'id,monto,modo'],
    ['cobros', 'id,tipo,periodo,anulado'],
    ['pagos', 'id,recibo,metodo,anulado'],
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
    $('#salirSinAcceso').addEventListener('click', () => AcuSesion.cerrar(sb, PAGINA_ACCESO));
    return;
  }
  miPerfil = perfil;
  aplicarPermisosFormas();
  aplicarPermisos();
  // Cierre automático si nadie usa la administración durante un rato (antes se guardan los cambios pendientes)
  AcuSesion.vigilarInactividad({auth:{signOut:async o => { try { await flush(); } catch (e){} return sb.auth.signOut(o); }}}, {destino:PAGINA_ACCESO});
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
    revisarAvisos().then(actualizarBadgeCortes);
    convertirConexionesAntiguas();
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
