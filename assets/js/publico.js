/* =====================================================================
   Sitio público del acueducto
   Secciones: #/inicio, #/mapa, #/calendario, #/reportar (y #/registro)
   ===================================================================== */
(function(){
'use strict';
const $ = s => document.querySelector(s);
const esc = Acu.esc, TIPOS = Acu.TIPOS, ROJO = Acu.ROJO;
function aviso(txt, ms){ const a = $('#aviso'); a.textContent = txt; a.classList.add('ver'); clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('ver'), ms || 3500); }
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const capitalizar = s => s.charAt(0).toUpperCase() + s.slice(1);
function duracion(a, b){
  const min = Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return h + ' h' + (m ? ' ' + m + ' min' : '');
  const d = Math.floor(h / 24);
  return d + (d === 1 ? ' día' : ' días') + (h % 24 ? ' ' + (h % 24) + ' h' : '');
}
function explicarError(e){
  const m = String((e && (e.message || e.details)) || e || '');
  if (e && e.code === 'P0001') return m;
  if (/failed to fetch|networkerror|load failed/i.test(m) || !navigator.onLine) return 'No hay conexión a internet. Inténtalo de nuevo.';
  if (/jwt|expired/i.test(m)) return 'Tu sesión expiró. Vuelve a iniciar sesión.';
  if (/row-level security|permission denied/i.test(m)) return 'Tu cuenta no tiene permiso para esto.';
  return 'No se pudo completar. ' + m;
}

let sb = null, config = {}, sesion = null, perfil = null;
const capas = new Map();          // elementos del mapa público (id -> capa con .fila)
const incsTodas = new Map();      // incidencias públicas (abiertas y resueltas)
const abiertas = () => [...incsTodas.values()].filter(i => (i.estado || 'abierta') === 'abierta');

/* =====================================================================
   MAPA EN VIVO
   ===================================================================== */
const map = Acu.crearMapa('map', {aviso});
map.createPane('incidencias').style.zIndex = 450;
const grupos = {sector:L.layerGroup().addTo(map), tuberia:L.layerGroup().addTo(map), llave:L.layerGroup().addTo(map), casa:L.layerGroup().addTo(map)};
const capaInc = L.layerGroup().addTo(map);
const capaFlechas = L.layerGroup();
let afectados = new Map(), tocados = new Map(), resultados = new Map();
let versionGeo = 0, redCache = null, mapaAjustado = false;

const elementos = () => [...capas.values()].map(l => ({id:l.fila.id, tipo:l.fila.tipo, datos:l.fila.datos || {}, layer:l}));
function red(){ if (!redCache || redCache.v !== versionGeo) redCache = {v:versionGeo, red:Acu.construirRed(elementos())}; return redCache.red; }
const nombreSector = id => { const l = capas.get(id); return l ? (l.fila.datos.nombre || 'Sector sin nombre') : ''; };
function nombreElemento(r){
  if (!r) return 'la red';
  const d = r.datos || {};
  if (r.tipo === 'casa') return d.numero ? 'Casa ' + d.numero : 'Casa';
  if (r.tipo === 'tuberia') return (d.clase === 'acometida' ? 'Acometida' : 'Tubería') + (d.nombre ? ' ' + d.nombre : '');
  if (r.tipo === 'llave') return d.nombre ? 'Llave ' + d.nombre : 'Llave';
  if (r.tipo === 'sector') return d.nombre || 'Sector';
  if (r.tipo === 'conector') return 'Unión en ' + (d.forma === 'Y' ? 'Y' : 'T') + (d.nombre ? ': ' + d.nombre : '');
  return 'Elemento';
}
const lugarDe = inc => { const o = capas.get(inc.forma_id); return o ? nombreElemento(o.fila) : 'la red'; };
function incsDe(id){
  const vistas = new Set(), out = [];
  [...(afectados.get(id) || []), ...(tocados.get(id) || [])].forEach(i => { if (!vistas.has(i.id)){ vistas.add(i.id); out.push(i); } });
  return out;
}
const textoIncs = id => [...new Set(incsDe(id).map(i => i.tipo))].join(', ');
const marcar = (layer, cls, si) => { const el = layer.getElement && layer.getElement(); if (el) el.classList.toggle(cls, !!si); };

function estilo(layer){
  const r = layer.fila, d = r.datos || {};
  if (r.tipo === 'conector'){
    const lista = afectados.get(r.id);
    layer.setStyle({color:lista && lista.length ? (lista[0].color || ROJO) : '#0B5C73'});
    return;
  }
  const esPunto = layer instanceof L.CircleMarker, esPol = layer instanceof L.Polygon;
  const lista = afectados.get(r.id);
  if (lista && lista.length){
    const inc = lista[0], col = inc.color || ROJO, op = Math.min(1, Math.max(.05, Number(inc.opacidad) || .75));
    Acu.quitarClasesSector(layer);
    if (esPunto) layer.setStyle({radius:r.tipo === 'llave' ? 8 : 6, color:'#fff', weight:2, fillColor:col, fillOpacity:op});
    else if (esPol) layer.setStyle({color:col, weight:2.5, opacity:1, fillColor:col, fillOpacity:op, dashArray:null});
    else layer.setStyle({color:col, weight:Acu.grosorTuberia(d) + .5, opacity:op, lineCap:'round', dashArray:null});
    marcar(layer, 'con-incidencia', true);
    if (r.tipo === 'sector'){ Acu.ponerEtiquetaSector(layer, d, textoIncs(r.id)); if (layer._map) layer.bringToBack(); }
    return;
  }
  marcar(layer, 'con-incidencia', false);
  const cat = r.tipo === 'casa' ? categorias.find(c => c.id === ((r.datos || {}).categoria || 'casa')) : null;
  const col = r.tipo === 'tuberia' ? Acu.COLOR_TUBERIA : cat ? cat.color : (r.color || (TIPOS[r.tipo] || TIPOS.sin).color);
  if (r.tipo === 'sector' && esPol){ Acu.estiloSector(layer, col, d, false); Acu.ponerEtiquetaSector(layer, d, textoIncs(r.id)); return; }
  if (esPunto){
    const cerrada = r.tipo === 'llave' && d.estado === 'cerrada';
    layer.setStyle({radius:r.tipo === 'llave' ? 8 : 6, color:cerrada ? col : '#fff', weight:cerrada ? 3 : 2, fillColor:col, fillOpacity:cerrada ? 0.15 : 0.95});
  } else if (esPol) layer.setStyle({color:col, weight:1.5, opacity:1, fillColor:col, fillOpacity:0.5, dashArray:null});
  else layer.setStyle({color:col, weight:r.tipo === 'tuberia' ? Acu.grosorTuberia(d) : 3, opacity:.95, lineCap:'round', dashArray:null});
}

function explicacion(inc, id){
  const res = resultados.get(inc.id);
  if (inc.forma_id === id){
    if (inc.ubicacion === 'punto') return 'En un punto de esta tubería (marcado con !)';
    if (inc.ubicacion === 'tramo_ab') return 'Entre los puntos A y B marcados';
    return 'Reportada aquí';
  }
  if (res && res.tubos.has(id) && !res.formas.has(id)) return 'Afecta una parte de esta tubería';
  return 'Por una incidencia en ' + lugarDe(inc);
}
function contenidoPopup(layer){
  const r = layer.fila, d = r.datos || {}, lista = incsDe(r.id), meta = [];
  if (r.tipo === 'tuberia'){
    meta.push([d.clase === 'acometida' ? 'Conexión a una casa' : 'Línea principal', d.diametro ? d.diametro + '"' : '', d.material].filter(Boolean).map(esc).join(' · '));
    const secs = (d.sectores || []).map(nombreSector).filter(Boolean);
    if (secs.length) meta.push('Abastece: ' + esc(secs.join(', ')));
  }
  if (r.tipo === 'llave') meta.push(d.estado === 'cerrada' ? 'Llave cerrada' : 'Llave abierta');
  if (r.tipo === 'conector') meta.push('Divide el agua en dos tuberías');
  if (r.tipo === 'sector') meta.push(esc((d.activo ? 'Con agua ' : 'Sin agua ') + Acu.desde(d.activoDesde)));
  const llaves = sinAguaPorLlave.get(r.id);
  if (llaves && !lista.length) return `<h3>${esc(nombreElemento(r))}</h3>${meta.filter(Boolean).length ? `<p class="meta">${meta.filter(Boolean).join('<br>')}</p>` : ''}
    <div class="estado mal">⛔ Sin agua: llave cerrada (${esc([...new Set(llaves)].join(', '))})<small>El servicio vuelve cuando se abra la llave.</small></div>`;
  const estado = lista.length
    ? `<div class="estado mal">${lista.map(i => `⚠ ${esc(i.tipo)}<small>${esc(explicacion(i, r.id))} · desde ${esc(Acu.fechaHora(i.creada_en))}${i.detalle_publico ? '<br>' + esc(i.detalle_publico) : ''}</small>`).join('')}</div>`
    : `<div class="estado ok">✓ ${r.tipo === 'tuberia' ? 'Funcionando con normalidad' : 'Sin incidencias'}</div>`;
  return `<h3>${esc(nombreElemento(r))}</h3>${meta.filter(Boolean).length ? `<p class="meta">${meta.filter(Boolean).join('<br>')}</p>` : ''}${estado}`;
}

function quitar(id){ const l = capas.get(id); if (!l) return; Object.values(grupos).forEach(g => g.removeLayer(l)); capas.delete(id); versionGeo++; }
function agregar(r){
  quitar(r.id);
  const grupo = grupos[r.tipo === 'conector' ? 'tuberia' : r.tipo]; if (!grupo) return;
  const layer = r.tipo === 'conector'
    ? (r.geometria && r.geometria.type === 'Point' ? Acu.formaConector(L.latLng(r.geometria.coordinates[1], r.geometria.coordinates[0]), r.datos, {interactivo:true, grosor:5}) : null)
    : Acu.capaDesdeGeom(r.geometria, r.datos);
  if (!layer) return;
  layer.fila = r;
  layer.addTo(grupo);
  capas.set(r.id, layer);
  layer.bindPopup(() => contenidoPopup(layer), {className:'popup-acu', maxWidth:290});
  if (r.tipo !== 'sector') Acu.ponerTooltip(layer, esc(nombreElemento(r)));
  estilo(layer);
  versionGeo++;
}
function ordenarSectores(){ grupos.sector.eachLayer(l => { if (l._map) l.bringToBack(); }); }

/* Efectos publicados por la administración (sirven aunque la red esté oculta) */
let efectos = [], categorias = [];
const redOculta = () => !!config.ocultar_red_vecinos;
map.createPane('cierres').style.zIndex = 445;      // por encima de tuberías y casas
const capaCierres = L.layerGroup().addTo(map);
/* Llaves cerradas: casas y sectores sin agua (y tuberías sin flujo si la red es visible) */
function dibujarCierres(){
  // Los sectores que estaban sin agua por una llave recuperan su etiqueta normal
  sinAguaPorLlave.forEach((_, id) => { const l = capas.get(id); if (l && l.fila.tipo === 'sector') estilo(l); });
  capaCierres.clearLayers();
  sinAguaPorLlave = new Map();
  const marcar = (id, llave) => { if (!sinAguaPorLlave.has(id)) sinAguaPorLlave.set(id, []); sinAguaPorLlave.get(id).push(llave); };
  const pintar = (casas, sectores, etiqueta, piezas, tubos) => {
    // En rojo: tuberías desde la llave en adelante y las casas y/o sectores sin agua
    (piezas || []).forEach(p => L.polyline(p.latlngs, {pane:'cierres', color:'#D32F2F', weight:7, opacity:.95, lineCap:'round', className:'con-incidencia', interactive:false}).addTo(capaCierres));
    (tubos || []).forEach(id => { const t = capas.get(id); if (t && t.fila.tipo === 'tuberia' && t.getLatLngs)
      L.polyline(t.getLatLngs(), {pane:'cierres', color:'#D32F2F', weight:Math.max(6, Acu.grosorTuberia(t.fila.datos || {}) + 2), opacity:.95, lineCap:'round', className:'con-incidencia', interactive:false}).addTo(capaCierres); });
    casas.forEach(id => { const c = capas.get(id); if (!c) return; marcar(id, etiqueta);
      (c.getBounds ? L.polygon(c.getLatLngs(), {pane:'cierres', color:'#B71C1C', weight:2.5, fillColor:'#E53935', fillOpacity:.7, className:'con-incidencia', interactive:false})
        : L.circleMarker(c.getLatLng(), {pane:'cierres', radius:9, color:'#B71C1C', weight:2.5, fillColor:'#E53935', fillOpacity:.7, interactive:false})).addTo(capaCierres); });
    sectores.forEach(id => { const s2 = capas.get(id); if (!s2 || !s2.getBounds) return; marcar(id, etiqueta);
      L.polygon(s2.getLatLngs(), {pane:'cierres', color:'#C62828', weight:2.5, dashArray:'8 6', fillColor:'#E53935', fillOpacity:.28, interactive:false}).addTo(capaCierres);
      Acu.ponerEtiquetaSector(s2, {...(s2.fila.datos || {}), activo:false}, 'Llave cerrada: ' + String(etiqueta).replace(/^Llave\s+/i, '').replace(/\s*\(cerrada\)$/i, '')); });
  };
  const llavesLocales = [...capas.values()].filter(l => l.fila.tipo === 'llave' && (l.fila.datos || {}).estado === 'cerrada');
  if (!redOculta() && llavesLocales.length){
    const rd = red();
    llavesLocales.forEach(l => { const r = Acu.efectoLlave(rd, l.fila.id, l.fila.datos.efectoCierre || 'ambos'); pintar([...r.casas], [...r.sectores], l.fila.datos.nombre || 'la llave', r.piezas, [...r.formas]); });
  } else {
    efectos.filter(e => e.tipo === 'llave').forEach(e => pintar(e.casas || [], e.sectores || [], e.etiqueta || 'una llave cerrada'));
  }
}
let sinAguaPorLlave = new Map();

function recalcular(){
  dibujarCierres();
  if (redOculta()) return recalcularOculta();
  const rd = red();
  resultados = new Map();
  const antes = new Set([...afectados.keys(), ...tocados.keys()]);
  const nA = new Map(), nT = new Map();
  const poner = (m, id, inc) => { if (!m.has(id)) m.set(id, []); m.get(id).push(inc); };
  capaInc.clearLayers();
  (historico ? [historico] : abiertas()).sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en))).forEach(inc => {
    const o = capas.get(inc.forma_id);
    const res = Acu.afectacion(rd, inc, o ? {id:o.fila.id, tipo:o.fila.tipo} : null);
    resultados.set(inc.id, res);
    res.formas.forEach(id => poner(nA, id, inc));
    res.tubos.forEach(id => { if (!res.formas.has(id)) poner(nT, id, inc); });
    if (o && !res.formas.has(inc.forma_id) && !res.tubos.has(inc.forma_id)) poner(nT, inc.forma_id, inc);
    const col = inc.color || ROJO;
    res.piezas.forEach(p => {
      L.polyline(p.latlngs, {pane:'incidencias', color:col, weight:7, opacity:.95, lineCap:'round', className:'con-incidencia'})
        .on('click', ev => { const t = capas.get(p.tubo); if (t) L.popup({className:'popup-acu', maxWidth:290}).setLatLng(ev.latlng).setContent(contenidoPopup(t)).openOn(map); })
        .addTo(capaInc);
    });
    res.puntos.forEach((ll, i) => {
      const txt = res.puntos.length > 1 ? (i ? 'B' : 'A') : '!';
      L.marker(ll, {icon:Acu.iconoIncidencia(txt), zIndexOffset:1000, keyboard:false})
        .bindPopup(`<h3>⚠ ${esc(inc.tipo)}</h3><p class="meta">${res.puntos.length > 1 ? `Punto ${txt} del tramo afectado` : 'Lugar del problema'}${o ? ' en ' + esc(nombreElemento(o.fila)) : ''}</p>
          <div class="estado mal">Desde ${esc(Acu.fechaHora(inc.creada_en))}<small>${esc(inc.detalle_publico || Acu.hace(inc.creada_en))}</small></div>`, {className:'popup-acu', maxWidth:290})
        .addTo(capaInc);
    });
  });
  afectados = nA; tocados = nT;
  new Set([...antes, ...afectados.keys(), ...tocados.keys()]).forEach(id => { const l = capas.get(id); if (l) estilo(l); });
  ordenarSectores();
  renderPanelMapa();
  renderVistaActual();
}
const recalcularPronto = debounce(recalcular, 200);

function recalcularOculta(){
  resultados = new Map();
  const antes = new Set([...afectados.keys(), ...tocados.keys()]);
  const nA = new Map(), poner = (id, inc) => { if (!nA.has(id)) nA.set(id, []); nA.get(id).push(inc); };
  capaInc.clearLayers();
  const lista = historico ? [historico] : abiertas();
  lista.forEach(inc => {
    const e = efectos.find(x => x.tipo === 'incidencia' && x.ref === inc.id);
    const casas = new Set(e ? e.casas : []), sectores = new Set(e ? e.sectores : []);
    if (capas.has(inc.forma_id)) (capas.get(inc.forma_id).fila.tipo === 'sector' ? sectores : casas).add(inc.forma_id);
    const formas = new Set([...casas, ...sectores]);
    resultados.set(inc.id, {formas, tubos:new Set(), casas, sectores, llaves:new Set(), piezas:[], puntos:[]});
    formas.forEach(id => poner(id, inc));
  });
  afectados = nA; tocados = new Map();
  new Set([...antes, ...afectados.keys()]).forEach(id => { const l = capas.get(id); if (l) estilo(l); });
  ordenarSectores();
  renderPanelMapa();
  renderVistaActual();
}
function casasAfectadas(){ const s = new Set(); resultados.forEach(r => r.casas.forEach(c => s.add(c))); return s; }
/* ---------- Modo historial: solo una incidencia pasada y lo que afectó ---------- */
let historico = null;
function verHistorico(inc){
  if (!inc || !capas.has(inc.forma_id)){ aviso('Ese lugar ya no aparece en el mapa.'); return; }
  historico = inc;
  irA('mapa');
  map.closePopup();
  map.getContainer().classList.add('modo-historial');
  recalcular();
  const res = resultados.get(inc.id), bnd = L.latLngBounds([]);
  [...(res ? [...res.formas, ...res.tubos] : []), inc.forma_id].forEach(id => { const l = capas.get(id); if (l) bnd.extend(l.getBounds ? l.getBounds() : l.getLatLng()); });
  if (res) res.puntos.forEach(p => bnd.extend(p));
  setTimeout(() => { map.invalidateSize(); if (bnd.isValid()) map.fitBounds(bnd, {maxZoom:18, padding:[50,50]}); }, 60);
  const abierta = (inc.estado || 'abierta') === 'abierta';
  const b = $('#bannerHist');
  b.innerHTML = `<div class="bh-cab"><span class="bh-etq">📅 Historial</span><b>${esc(inc.tipo)}</b>
      <span class="pill ${abierta ? 'bad' : 'ok'}">${abierta ? 'En atención' : 'Resuelta'}</span></div>
    <p><b>${esc(lugarDe(inc))}</b></p>
    <p>Ocurrió: <b>${esc(Acu.fechaHora(inc.creada_en))}</b>${inc.resuelta_en ? ` · Resuelta: <b>${esc(Acu.fechaHora(inc.resuelta_en))}</b> · duró ${esc(duracion(inc.creada_en, inc.resuelta_en))}` : ''}</p>
    ${res ? `<p>Afectó: ${esc(Acu.textoAfectacion(res))}</p>` : ''}
    ${inc.detalle_publico ? `<p class="bh-det">${esc(inc.detalle_publico)}</p>` : ''}
    <button class="btn primario" id="salirHist">Volver al mapa en vivo</button>`;
  b.hidden = false;
  $('#salirHist').addEventListener('click', salirHistorico);
  plegarEnMovil();
}
function salirHistorico(){
  if (!historico) return;
  historico = null;
  $('#bannerHist').hidden = true;
  map.getContainer().classList.remove('modo-historial');
  recalcular();
}
function enfocarIncidencia(inc){
  salirHistorico();
  irA('mapa');
  const res = resultados.get(inc.id), bnd = L.latLngBounds([]);
  const ids = res ? [...res.formas, ...res.tubos, inc.forma_id] : [inc.forma_id];
  ids.forEach(id => { const l = capas.get(id); if (l) bnd.extend(l.getBounds ? l.getBounds() : l.getLatLng()); });
  if (res) res.puntos.forEach(p => bnd.extend(p));
  if (bnd.isValid()) map.fitBounds(bnd, {maxZoom:18, padding:[40,40]});
  const o = capas.get(inc.forma_id);
  if (o) setTimeout(() => (res && res.puntos.length ? L.popup({className:'popup-acu'}).setLatLng(res.puntos[0]).setContent(contenidoPopup(o)).openOn(map) : o.openPopup()), 400);
}

function sectoresOrdenados(){
  return [...capas.values()].filter(l => l.fila.tipo === 'sector')
    .sort((a, b) => String(a.fila.datos.nombre || '').localeCompare(String(b.fila.datos.nombre || ''), 'es', {numeric:true}));
}
function filaSector(l, i){
  const d = l.fila.datos || {}, llave = sinAguaPorLlave.get(l.fila.id), activo = !!d.activo && !llave, inc = textoIncs(l.fila.id) || (llave ? 'Llave cerrada: ' + [...new Set(llave)].join(', ') : '');
  const muestra = inc ? ROJO : activo ? (l.fila.color || TIPOS.sector.color) : Acu.SIN_FLUJO.relleno;
  return `<li><button data-sector="${i}"><i class="muestra" style="background:${esc(muestra)}"></i>
    <span class="nom">${esc(d.nombre || 'Sector sin nombre')}<small>${esc(inc ? '⚠ ' + inc : Acu.desde(d.activoDesde))}</small></span>
    <span class="pill ${activo ? 'con' : 'sin'}">${activo ? 'Con agua' : llave ? 'Sin agua (llave)' : 'Sin agua'}</span></button></li>`;
}
function enlazarSectores(cont, sectores){
  cont.querySelectorAll('[data-sector]').forEach(b => b.addEventListener('click', () => {
    const l = sectores[Number(b.dataset.sector)];
    irA('mapa');
    if (!map.hasLayer(grupos.sector)) mostrarGrupo('sector', true);
    map.fitBounds(l.getBounds(), {maxZoom:18, padding:[40,40]});
    plegarEnMovil();
  }));
}
function renderPanelMapa(){
  const lista = abiertas().filter(i => redOculta() || capas.has(i.forma_id)).sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en)));
  const est = $('#estadoRed'), ul = $('#listaIncs');
  if (!lista.length){ est.innerHTML = '<div class="ok-red">✓ No hay incidencias en la red en este momento.</div>'; ul.hidden = true; }
  else {
    const n = historico ? 0 : casasAfectadas().size;
    est.innerHTML = `<div class="mal-red"><b>${lista.length}</b>${lista.length === 1 ? 'incidencia activa' : 'incidencias activas'}${n ? ` · ${n} ${n === 1 ? 'casa afectada' : 'casas afectadas'}` : ''}</div>`;
    ul.hidden = false;
    ul.innerHTML = lista.map((i, k) => `<li><button data-inc="${k}"><i class="muestra" style="background:${ROJO}"></i>
      <span class="nom">${esc(i.tipo)}<small>${esc(lugarDe(i))} · ${esc(Acu.desde(i.creada_en))}</small></span><span class="pill sin">Ver</span></button></li>`).join('');
    ul.querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => { enfocarIncidencia(lista[Number(b.dataset.inc)]); plegarEnMovil(); }));
  }
  const sectores = sectoresOrdenados(), conAgua = sectores.filter(l => l.fila.datos.activo).length;
  const res = $('#resumenAgua'), us = $('#listaSectores');
  if (!sectores.length){ res.innerHTML = '<b>—</b>Todavía no hay sectores publicados.'; us.innerHTML = ''; us.hidden = true; return; }
  us.hidden = false;
  res.innerHTML = `<b>${conAgua} de ${sectores.length}</b>${sectores.length === 1 ? 'sector' : 'sectores'} con agua en este momento`;
  us.innerHTML = sectores.map(filaSector).join('');
  enlazarSectores(us, sectores);
}

function dibujarFlechas(){
  Acu.dibujarFlechas(map, elementos(), capaFlechas);
  const ver = map.getZoom() >= 16 && map.hasLayer(grupos.tuberia);
  if (ver && !map.hasLayer(capaFlechas)) capaFlechas.addTo(map);
  if (!ver && map.hasLayer(capaFlechas)) map.removeLayer(capaFlechas);
}
const flechasPronto = debounce(dibujarFlechas, 300);
map.on('zoomend', dibujarFlechas);

function mostrarGrupo(tipo, visible){
  const g = grupos[tipo];
  if (visible){ g.addTo(map); g.eachLayer(estilo); ordenarSectores(); } else map.removeLayer(g);
  const c = document.querySelector(`[data-capa="${tipo}"]`); if (c) c.checked = visible;
  if (tipo === 'tuberia') dibujarFlechas();
}
document.querySelectorAll('[data-capa]').forEach(c => c.addEventListener('change', () => mostrarGrupo(c.dataset.capa, c.checked)));
$('#formBuscar').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#buscaCasa').value.trim().toLowerCase().replace(/^casa\s*/, '');
  if (!q) return;
  const l = [...capas.values()].find(x => x.fila.tipo === 'casa' && String(x.fila.datos.numero || '').trim().toLowerCase() === q);
  if (!l){ aviso('No encontramos la casa ' + $('#buscaCasa').value.trim() + '.'); return; }
  if (!map.hasLayer(grupos.casa)) mostrarGrupo('casa', true);
  if (l.getBounds) map.fitBounds(l.getBounds(), {maxZoom:19, padding:[60,60]}); else map.setView(l.getLatLng(), 19);
  setTimeout(() => l.openPopup(), 400);
  plegarEnMovil();
});
$('#plegar').addEventListener('click', () => {
  const plegado = $('#info').classList.toggle('plegado');
  $('#plegar').textContent = plegado ? '▴' : '▾';
  $('#plegar').setAttribute('aria-expanded', String(!plegado));
});
function plegarEnMovil(){ if (window.innerWidth <= 700 && !$('#info').classList.contains('plegado')) $('#plegar').click(); }
function ajustarMapa(){
  map.invalidateSize();
  if (mapaAjustado) return;
  const b = L.latLngBounds([]);
  capas.forEach(l => b.extend(l.getBounds ? l.getBounds() : l.getLatLng()));
  if (b.isValid()){ map.fitBounds(b, {maxZoom:18, padding:[30,30]}); mapaAjustado = true; }
}

/* =====================================================================
   SECCIONES
   ===================================================================== */
let vistaActual = null;
const RENDER = {inicio:renderInicio, calendario:renderCalendario, reportar:renderReportar, perfil:renderPerfil};
function router(){
  let ruta = location.hash.replace(/^#\/?/, '') || 'inicio';
  let abrirReg = false;
  if (ruta === 'registro'){ location.replace('assets/pages/auth/auth.html?modo=registro'); return; }
  if (!['inicio', 'mapa', 'calendario', 'reportar', 'perfil'].includes(ruta)) ruta = 'inicio';
  irA(ruta, true);

}
function irA(v, desdeRouter){
  if (!desdeRouter && location.hash !== '#/' + v) history.pushState(null, '', '#/' + v);
  const cambio = vistaActual !== v;
  if (v !== 'mapa') salirHistorico();
  vistaActual = v;
  if (cambio){
    document.querySelectorAll('[data-vista]').forEach(s => { s.hidden = s.dataset.vista !== v; });
    document.querySelectorAll('#nav a, #barraInferior a').forEach(a => { if (a.dataset.ruta === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('#pie').hidden = v === 'mapa';
    document.body.classList.toggle('en-mapa', v === 'mapa');
    $('#vistas').scrollTop = 0;
    if (v === 'mapa') setTimeout(ajustarMapa, 0);
  }
  $('#nav').classList.remove('abierto'); $('#menuBtn').setAttribute('aria-expanded', 'false');
  renderVistaActual();
}
function renderVistaActual(){ const f = RENDER[vistaActual]; if (f) f(); }
window.addEventListener('hashchange', router);
$('#menuBtn').addEventListener('click', () => {
  const ab = $('#nav').classList.toggle('abierto');
  $('#menuBtn').setAttribute('aria-expanded', String(ab));
});
$('#nav').addEventListener('click', e => { if (e.target.closest('a')) $('#nav').classList.remove('abierto'); });

/* ---------- Inicio (dashboard) ---------- */
function renderInicio(){
  const act = abiertas().filter(i => redOculta() || capas.has(i.forma_id)).sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en)));
  const sectores = sectoresOrdenados(), conAgua = sectores.filter(l => l.fila.datos.activo).length;
  const nCasas = casasAfectadas().size;
  const ahora = new Date(), mes = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
  const resueltas = [...incsTodas.values()].filter(i => i.estado === 'resuelta' && i.resuelta_en)
    .sort((a, b) => String(b.resuelta_en).localeCompare(String(a.resuelta_en)));
  const resMes = resueltas.filter(i => { const d = new Date(i.resuelta_en); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === mes; }).length;
  const bien = !act.length;
  const tarjetaInc = (i, resuelta) => `<div class="inc-card ${resuelta ? 'resuelta' : ''}">
      <div class="cab"><b>${resuelta ? '✓' : '⚠'} ${esc(i.tipo)}</b><span class="nota">${esc(resuelta ? 'duró ' + duracion(i.creada_en, i.resuelta_en) : Acu.hace(i.creada_en))}</span></div>
      <p class="nota">${esc(lugarDe(i))} · ${resuelta ? 'Resuelta el ' + esc(Acu.fechaHora(i.resuelta_en)) : 'Desde ' + esc(Acu.fechaHora(i.creada_en))}</p>
      ${i.detalle_publico ? `<p class="msg">${esc(i.detalle_publico)}</p>` : ''}
      ${!resuelta ? `<div class="fila" style="margin-top:6px"><button class="btn" data-ver-inc="${esc(i.id)}">Ver en el mapa</button></div>` : ''}
    </div>`;
  const cont = $('#dash');
  cont.innerHTML = `
    <div class="estado-servicio ${bien ? '' : 'mal'}">
      <div class="icono" aria-hidden="true">${bien ? '✓' : '!'}</div>
      <div><h1>${bien ? 'Servicio funcionando con normalidad' : `${act.length} ${act.length === 1 ? 'incidencia activa' : 'incidencias activas'} en la red`}</h1>
        <p>${sectores.length ? `${conAgua} de ${sectores.length} ${sectores.length === 1 ? 'sector' : 'sectores'} con agua en este momento` : 'Estado del servicio de agua'}${nCasas ? ` · ${nCasas} ${nCasas === 1 ? 'casa afectada' : 'casas afectadas'}` : ''}</p></div>
      <span class="vivo"><i></i>En vivo</span>
    </div>
    <div class="kpis">
      <a class="kpi ${act.length ? 'rojo' : ''}" href="#/mapa"><span>Incidencias activas</span><b>${act.length}</b><small>${act.length ? 'Toca para verlas en el mapa' : 'Todo en orden'}</small></a>
      <a class="kpi" href="#/mapa"><span>Sectores con agua</span><b>${conAgua} de ${sectores.length}</b><small>${sectores.length && conAgua < sectores.length ? (sectores.length - conAgua) + ' sin agua' : 'Servicio completo'}</small></a>
      <a class="kpi ${nCasas ? 'rojo' : ''}" href="#/mapa"><span>Casas afectadas</span><b>${nCasas}</b><small>Por incidencias activas</small></a>
      <a class="kpi" href="#/calendario"><span>Resueltas este mes</span><b>${resMes}</b><small>Ver el calendario</small></a>
    </div>
    <div class="rejilla">
      <article class="tarjeta"><header><h2>Incidencias activas</h2><a href="#/mapa">Mapa en vivo</a></header>
        ${act.length ? act.slice(0, 5).map(i => tarjetaInc(i, false)).join('') : '<p class="vacio">✓ No hay incidencias en este momento.</p>'}</article>
      <article class="tarjeta"><header><h2>Agua por sector</h2><a href="#/mapa">Ver en el mapa</a></header>
        ${sectores.length ? `<ul class="lista" id="dashSectores">${sectores.map(filaSector).join('')}</ul>` : '<p class="vacio">Todavía no hay sectores publicados.</p>'}</article>
      <article class="tarjeta"><header><h2>Últimas incidencias resueltas</h2><a href="#/calendario">Calendario</a></header>
        ${resueltas.length ? resueltas.slice(0, 4).map(i => tarjetaInc(i, true)).join('') : '<p class="vacio">Todavía no hay incidencias resueltas.</p>'}</article>
      <article class="tarjeta"><header><h2>¿Tienes un problema con el agua?</h2></header>
        <p class="nota" style="margin-top:0">Los representantes de cada casa pueden enviar reportes de fugas, falta de agua o baja presión.</p>
        <div class="fila"><a class="btn primario" href="#/reportar">Enviar un reporte</a>${waURL() ? `<a class="btn" href="${esc(waURL())}" target="_blank" rel="noopener">Escribir por WhatsApp</a>` : ''}</div></article>
    </div>
    <div class="accesos">
      <a class="acceso" href="#/mapa"><span class="ic" aria-hidden="true">🗺️</span><span><b>Mapa en vivo</b><small>Tuberías, sectores y el estado de cada uno</small></span></a>
      <a class="acceso" href="#/calendario"><span class="ic" aria-hidden="true">📅</span><span><b>Historial</b><small>Qué pasó cada día y a qué hora</small></span></a>
      <a class="acceso" href="#/reportar"><span class="ic" aria-hidden="true">📝</span><span><b>Enviar un reporte</b><small>Avísanos de un problema</small></span></a>
    </div>`;
  cont.querySelectorAll('[data-ver-inc]').forEach(b => b.addEventListener('click', () => enfocarIncidencia(incsTodas.get(b.dataset.verInc))));
  const ds = $('#dashSectores'); if (ds) enlazarSectores(ds, sectores);
}

/* ---------- Calendario ---------- */
let calMes = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
const claveDia = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const horaCorta = iso => new Date(iso).toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'});
function renderCalendario(){
  const porDia = new Map();
  incsTodas.forEach(i => { const k = claveDia(new Date(i.creada_en)); if (!porDia.has(k)) porDia.set(k, []); porDia.get(k).push(i); });
  const y = calMes.getFullYear(), mo = calMes.getMonth();
  $('#calTitulo').textContent = capitalizar(calMes.toLocaleDateString('es', {month:'long', year:'numeric'}));
  const desfase = (new Date(y, mo, 1).getDay() + 6) % 7, hoy = claveDia(new Date());
  let total = 0;
  let html = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d => `<div class="cal-dow" aria-hidden="true">${d}</div>`).join('');
  for (let i = 0; i < 42; i++){
    const d = new Date(y, mo, 1 - desfase + i);
    if (i === 35 && d.getMonth() !== mo) break;
    const k = claveDia(d), lista = porDia.get(k) || [], enMes = d.getMonth() === mo;
    if (enMes) total += lista.length;
    const hayAbiertas = lista.some(x => (x.estado || 'abierta') === 'abierta');
    const tipos = [...new Set(lista.map(x => x.tipo))];
    const etq = d.toLocaleDateString('es', {weekday:'long', day:'numeric', month:'long'}) + (lista.length ? `, ${lista.length} ${lista.length === 1 ? 'incidencia' : 'incidencias'}` : '');
    html += `<button class="cal-dia ${enMes ? '' : 'fuera'} ${k === hoy ? 'hoy' : ''} ${lista.length ? (hayAbiertas ? 'con-abiertas' : 'todas-resueltas') : ''}" data-dia="${k}" aria-label="${esc(etq)}">
      <span class="num">${d.getDate()}</span>
      ${lista.length ? `<span class="cuenta-dia">${lista.length}</span><span class="tipos-dia">${esc(tipos.slice(0, 2).join(', '))}${tipos.length > 2 ? '…' : ''}</span>` : ''}</button>`;
  }
  $('#calGrid').innerHTML = html;
  $('#calResumen').textContent = total ? `${total} ${total === 1 ? 'incidencia' : 'incidencias'} este mes` : 'Sin incidencias este mes';
  $('#calGrid').querySelectorAll('[data-dia]').forEach(b => b.addEventListener('click', () => abrirDia(b.dataset.dia)));
}
function abrirDia(k){
  const [y, m, d] = k.split('-').map(Number);
  const ini = new Date(y, m - 1, d), fin = new Date(y, m - 1, d + 1);
  const todas = [...incsTodas.values()], porHora = (a, b) => new Date(a.creada_en) - new Date(b.creada_en);
  const ocurrieron = todas.filter(i => { const c = new Date(i.creada_en); return c >= ini && c < fin; }).sort(porHora);
  const seguian = todas.filter(i => { const c = new Date(i.creada_en), r = i.resuelta_en ? new Date(i.resuelta_en) : null; return c < ini && (!r || r >= ini); }).sort(porHora);
  const evento = i => {
    const c = new Date(i.creada_en), abierta = (i.estado || 'abierta') === 'abierta';
    return `<article class="evento ${abierta ? 'abierta' : 'resuelta'}">
      <div class="ev-hora"><b>${esc(horaCorta(i.creada_en))}</b><small>${c >= ini ? 'ocurrió' : esc(c.toLocaleDateString('es', {day:'numeric', month:'short'}))}</small></div>
      <div class="ev-cuerpo">
        <div class="ev-cab"><b>${abierta ? '⚠' : '✓'} ${esc(i.tipo)}</b><span class="pill ${abierta ? 'bad' : 'ok'}">${abierta ? 'En atención' : 'Resuelta'}</span></div>
        <p class="meta">${esc(lugarDe(i))}</p>
        ${i.detalle_publico ? `<p>${esc(i.detalle_publico)}</p>` : ''}
        <p class="ev-tiempos">Ocurrió: <b>${esc(Acu.fechaHora(i.creada_en))}</b><br>
          ${i.resuelta_en ? `Resuelta: <b>${esc(Acu.fechaHora(i.resuelta_en))}</b> · duró ${esc(duracion(i.creada_en, i.resuelta_en))}` : `Sigue en atención, ${esc(Acu.hace(i.creada_en).replace('hace ', 'desde hace '))}`}</p>
        ${capas.has(i.forma_id) ? `<button class="btn" data-ver-inc="${esc(i.id)}">Ver en el mapa</button>` : ''}
      </div></article>`;
  };
  $('#dlgTitulo').textContent = capitalizar(ini.toLocaleDateString('es', {weekday:'long', day:'numeric', month:'long', year:'numeric'}));
  let html = ocurrieron.length ? ocurrieron.map(evento).join('') : '<p class="vacio">No hubo incidencias este día.</p>';
  if (seguian.length) html += `<h3 class="dlg-sub">Seguían en atención de días anteriores</h3>${seguian.map(evento).join('')}`;
  const cuerpo = $('#dlgCuerpo');
  cuerpo.innerHTML = html;
  cuerpo.querySelectorAll('[data-ver-inc]').forEach(b => b.addEventListener('click', () => { $('#dlgDia').close(); verHistorico(incsTodas.get(b.dataset.verInc)); }));
  $('#dlgDia').showModal();
}
$('#calPrev').addEventListener('click', () => { calMes = new Date(calMes.getFullYear(), calMes.getMonth() - 1, 1); renderCalendario(); });
$('#calNext').addEventListener('click', () => { calMes = new Date(calMes.getFullYear(), calMes.getMonth() + 1, 1); renderCalendario(); });
$('#calHoy').addEventListener('click', () => { const d = new Date(); calMes = new Date(d.getFullYear(), d.getMonth(), 1); renderCalendario(); });
document.querySelectorAll('dialog').forEach(dl => {
  dl.addEventListener('click', e => { if (e.target === dl) dl.close(); });
  dl.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', () => dl.close()));
});

/* =====================================================================
   CUENTA, REPORTES Y REGISTRO
   ===================================================================== */
const puedeReportar = () => !!perfil && perfil.estado === 'activo';
function pintarCuenta(){
  const con = !!sesion;
  $('#btnEntrar').hidden = con;
  $('#btnCuenta').hidden = !con;
  if (!con){ $('#menuCuenta').hidden = true; return; }
  const nombre = (perfil && perfil.nombre) || sesion.user.email;
  $('#cuentaIni').textContent = (nombre || '?').trim().charAt(0).toUpperCase();
  $('#cuentaNombre').textContent = nombre;
  $('#menuNombre').textContent = nombre;
  $('#menuCorreo').textContent = sesion.user.email || '';
  $('#menuAdm').hidden = !(perfil && perfil.estado === 'activo' && ['administrador', 'desarrollador'].includes(perfil.rol));
}
$('#btnCuenta').addEventListener('click', e => {
  e.stopPropagation();
  const ab = $('#menuCuenta').hidden;
  $('#menuCuenta').hidden = !ab;
  $('#btnCuenta').setAttribute('aria-expanded', String(ab));
});
document.addEventListener('click', e => { if (!e.target.closest('#cuentaDer')) $('#menuCuenta').hidden = true; });
$('#btnSalir').addEventListener('click', () => AcuSesion.cerrar(sb, 'assets/pages/auth/auth.html'));

/* --- Enviar un reporte --- */
let mapaRep = null, marcaRep = null, puntoRep = null, abiertoRepEn = Date.now(), misReportes = [];
function renderReportar(){
  $('#repSinSesion').hidden = !!sesion;
  $('#repSinAcceso').hidden = !sesion || puedeReportar();
  $('#repConSesion').hidden = !(sesion && puedeReportar());
  $('#repAvisoClave').hidden = !(perfil && perfil.debe_cambiar_clave);
  if (sesion && !puedeReportar()){
    $('#repSinAccesoTxt').textContent = !perfil
      ? 'Tu cuenta todavía no tiene acceso. Si enviaste una solicitud, espera a que sea aprobada.'
      : 'Tu cuenta está suspendida. Comunícate con la administración del acueducto.';
  }
  if (sesion && puedeReportar()){ prepararMapaReporte(); renderMisReportes(); }
}
function prepararMapaReporte(){
  if (mapaRep){ setTimeout(() => mapaRep.invalidateSize(), 0); return; }
  mapaRep = Acu.crearMapa('mapaReporte', {aviso});
  mapaRep.ajustarFondos(config.ajuste_fondos || {});
  capas.forEach(l => {
    if (l.fila.tipo === 'tuberia') L.geoJSON(l.fila.geometria, {style:{color:Acu.COLOR_TUBERIA, weight:3, opacity:.9}, interactive:false}).addTo(mapaRep);
    if (l.fila.tipo === 'casa') L.geoJSON(l.fila.geometria, {style:{color:'#3B6EA8', weight:1, fillOpacity:.35}, interactive:false,
      pointToLayer:(f, ll) => L.circleMarker(ll, {radius:5})}).addTo(mapaRep);
  });
  const miCasa = (perfil && perfil.casa_id && capas.get(perfil.casa_id)) || (misCuentas[0] && capas.get(misCuentas[0].id));
  const b = L.latLngBounds([]);
  if (miCasa) b.extend(miCasa.getBounds ? miCasa.getBounds() : miCasa.getLatLng());
  else capas.forEach(l => b.extend(l.getBounds ? l.getBounds() : l.getLatLng()));
  setTimeout(() => { mapaRep.invalidateSize(); if (b.isValid()) mapaRep.fitBounds(b, {maxZoom:18, padding:[20,20]}); }, 0);
  mapaRep.on('click', e => ponerPuntoRep(e.latlng));
  mapaRep.on('locationfound', e => ponerPuntoRep(e.latlng));
}
function ponerPuntoRep(ll){
  puntoRep = {lat:+ll.lat.toFixed(7), lng:+ll.lng.toFixed(7)};
  if (marcaRep) marcaRep.setLatLng(ll);
  else marcaRep = L.marker(ll, {icon:Acu.iconoIncidencia('?')}).addTo(mapaRep);
  $('#repUbicacion').textContent = 'Ubicación marcada ✓';
  $('#repQuitarPunto').hidden = false;
}
$('#repQuitarPunto').addEventListener('click', () => {
  puntoRep = null;
  if (marcaRep){ mapaRep.removeLayer(marcaRep); marcaRep = null; }
  $('#repUbicacion').textContent = 'Sin ubicación marcada.';
  $('#repQuitarPunto').hidden = true;
});
$('#formReporte textarea').addEventListener('input', e => { $('#repContador').textContent = `${e.target.value.length} / 1000`; });
function mensajeForm(sel, texto, ok){ const m = $(sel); m.textContent = texto; m.className = 'mensaje-form ' + (ok ? 'ok' : 'mal'); m.hidden = false; }
let esperaRepHasta = 0;
function contarEsperaRep(){
  const b = $('#repEnviar'), falta = Math.ceil((esperaRepHasta - Date.now()) / 1000);
  if (falta > 0){ b.disabled = true; b.textContent = `Podrás enviar otro en ${falta} s`; setTimeout(contarEsperaRep, 1000); }
  else { b.disabled = false; b.textContent = 'Enviar reporte'; }
}
$('#formReporte').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f).entries());
  if (d.sitio_web){ mensajeForm('#repMensaje', 'No se pudo enviar.', false); return; }
  if (Date.now() - abiertoRepEn < 3000){ mensajeForm('#repMensaje', 'Revisa los datos antes de enviar.', false); return; }
  if (!d.tipo){ mensajeForm('#repMensaje', 'Elige qué está pasando.', false); return; }
  if ((d.descripcion || '').trim().length < 5){ mensajeForm('#repMensaje', 'Describe un poco más el problema.', false); return; }
  const b = $('#repEnviar'); b.disabled = true; b.textContent = 'Enviando…';
  const {error} = await sb.from('reportes').insert({tipo:d.tipo, descripcion:d.descripcion.trim(), punto:puntoRep,
    numero_casa:(perfil && perfil.numero_casa) || null});
  if (error){
    b.disabled = false; b.textContent = 'Enviar reporte';
    mensajeForm('#repMensaje', explicarError(error), false);
    const seg = /en (\d+) segundos/.exec(error.message || '');
    if (seg){ esperaRepHasta = Date.now() + Number(seg[1]) * 1000; contarEsperaRep(); }
    return;
  }
  f.reset(); $('#repContador').textContent = '0 / 1000'; $('#repQuitarPunto').click();
  mensajeForm('#repMensaje', '¡Gracias! Tu reporte llegó a la administración. Aquí verás su estado y la respuesta.', true);
  esperaRepHasta = Date.now() + 120000; contarEsperaRep();
  abiertoRepEn = Date.now();
  cargarMisReportes();
});
const NOMBRE_EST = {nuevo:'Recibido', en_revision:'En revisión', atendido:'Atendido', descartado:'Cerrado'};
const CLASE_EST = {nuevo:'nada', en_revision:'warn', atendido:'ok', descartado:'nada'};
async function cargarMisReportes(){
  if (!sesion) return;
  const {data} = await sb.from('reportes').select('*').eq('user_id', sesion.user.id).order('created_at', {ascending:false}).limit(50);
  misReportes = data || [];
  pintarNotificaciones();
  if (vistaActual === 'reportar') renderMisReportes();
}
function renderMisReportes(){
  $('#misReportes').innerHTML = misReportes.length ? misReportes.map(r => `<div class="mi-reporte">
      <div class="cab"><b>${esc(r.tipo)}</b><span class="pill ${CLASE_EST[r.estado]}">${esc(NOMBRE_EST[r.estado] || r.estado)}</span></div>
      <p class="nota">${esc(Acu.fechaHora(r.created_at))}${r.punto ? ' · con ubicación' : ''}</p>
      <p>${esc(r.descripcion)}</p>
      ${r.respuesta ? `<p class="respuesta"><b>Respuesta:</b> ${esc(r.respuesta)}</p>` : ''}
    </div>`).join('') : '<p class="vacio">Todavía no has enviado reportes.</p>';
}

/* =====================================================================
   ESTADO DE CUENTA DEL VECINO (una tarjeta por cada casa vinculada)
   ===================================================================== */
let misCuentas = [];
const capaMisCasas = L.layerGroup().addTo(map);
const METODOS_PAGO = {efectivo:'Efectivo', transferencia:'Transferencia', yappy:'Yappy', cheque:'Cheque', otro:'Otro'};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const dinero = n => (String(config.moneda || '').split(/[0-9]/)[0].trim().slice(0, 5) || 'B/.') + ' ' + r2(n).toFixed(2);
function mesNombre(per, corto){
  if (!/^\d{4}-\d{2}$/.test(per || '')) return per || '';
  const [y, m] = per.split('-').map(Number);
  return capitalizar(new Date(y, m - 1, 1).toLocaleDateString('es', corto ? {month:'short', year:'numeric'} : {month:'long', year:'numeric'}));
}
function masMeses(per, n){ let [y, m] = per.split('-').map(Number); m += n; while (m > 12){ m -= 12; y++; } return `${y}-${String(m).padStart(2, '0')}`; }
const mesHoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const fechaCorta = f => f ? new Date(String(f).slice(0, 10) + 'T12:00:00').toLocaleDateString('es', {day:'numeric', month:'short', year:'numeric'}) : '—';

/* Mismo cálculo que la administración: los pagos cubren primero lo más antiguo */
function calcularCuenta(x){
  const cargos = [...(x.cobros || [])], pagos = x.pagos || [];
  const cargado = r2(cargos.reduce((s, c) => s + Number(c.monto), 0)), pagado = r2(pagos.reduce((s, p) => s + Number(p.monto), 0));
  const saldo = r2(cargado - pagado);
  let resto = pagado; const pendientes = [];
  cargos.forEach(c => { const m = Number(c.monto); if (resto >= m - 0.005) resto = r2(resto - m); else { pendientes.push({...c, falta:r2(m - resto)}); resto = 0; } });
  const hoy = mesHoy(), atraso = pendientes.filter(c => c.tipo === 'cuota' && c.periodo < hoy).length;
  const cuota = Number(x.cuota_mensual) || 0, cuotas = cargos.filter(c => c.tipo === 'cuota').map(c => c.periodo).sort();
  let adelanto = [];
  if (saldo < 0 && cuota > 0){
    const desde = cuotas.length ? masMeses(cuotas[cuotas.length - 1], 1) : hoy;
    adelanto = Array.from({length:Math.min(24, Math.floor((-saldo + 0.005) / cuota))}, (_, i) => masMeses(desde, i));
  }
  let arreglo = null;
  if (x.arreglo){
    const a = x.arreglo, deuda = Number(a.deuda), avance = Math.min(deuda, Math.max(0, r2(deuda - Math.max(0, saldo))));
    const cubiertas = Math.min(a.cuotas, Math.floor((avance + 0.005) / Number(a.monto_cuota)));
    const proxima = cubiertas < a.cuotas ? masMeses(String(a.inicio).slice(0, 7), cubiertas) : null;
    arreglo = {...a, avance, cubiertas, proxima, atrasado:!!proxima && hoy > proxima};
  }
  return {saldo, pendientes, atraso, adelanto, arreglo, aplica:cargos.length > 0 || pagos.length > 0};
}

/* Con quién comparte la línea de agua (según el mapa público) */
function infoRedCasa(casaId){
  const rd = red(), inicio = rd.casaNodos && rd.casaNodos.get(casaId);
  if (!inicio || !inicio.size) return null;
  const clase = t => { const l = capas.get(t); return l && l.fila.datos.clase === 'acometida' ? 'acometida' : 'principal'; };
  const principalesDe = nodos => {
    const out = new Set(), vistos = new Set(nodos), cola = [...nodos];
    while (cola.length){
      const n = cola.shift();
      (rd.ady.get(n) || []).forEach(v => {
        if (!v.e.virtual && clase(v.e.tubo) === 'principal'){ out.add(v.e.tubo); return; }
        if (!vistos.has(v.otro)){ vistos.add(v.otro); cola.push(v.otro); }
      });
    }
    return out;
  };
  const mias = principalesDe(inicio);
  const mismaLinea = [];
  rd.casaNodos.forEach((nodos, id) => {
    if (id === casaId || !nodos.size) return;
    const suyas = principalesDe(nodos);
    if ([...suyas].some(t => mias.has(t))) mismaLinea.push(id);
  });
  // Aguas abajo: solo por tuberías con la dirección del agua definida, saliendo de esta casa
  const abajoSet = new Set(), vistosA = new Set(inicio), colaA = [...inicio];
  while (colaA.length){
    const n = colaA.shift();
    (rd.nodoCasas.get(n) || []).forEach(id => { if (id !== casaId) abajoSet.add(id); });
    (rd.ady.get(n) || []).forEach(v => {
      if (!v.puede || vistosA.has(v.otro)) return;
      if (!v.e.virtual && !rd.tuboDir.get(v.e.tubo)) return;     // sin dirección definida: no se puede saber
      vistosA.add(v.otro); colaA.push(v.otro);
    });
  }
  const abajo = [...abajoSet];
  const nombre = id => { const l = capas.get(id); return l ? nombreElemento(l.fila) : ''; };
  const orden = (a, b) => nombre(a).localeCompare(nombre(b), 'es', {numeric:true});
  return {lineas:[...mias].map(nombre).filter(Boolean), mismaLinea:mismaLinea.sort(orden).map(nombre), abajo:abajo.sort(orden).map(nombre)};
}

async function cargarMisCuentas(){
  if (!sesion){ misCuentas = []; marcarMisCasas(); return; }
  const {data, error} = await sb.rpc('mi_estado_cuenta');
  if (error){ console.warn('mi_estado_cuenta', error.message); return; }
  misCuentas = Array.isArray(data) ? data : [];
  marcarMisCasas();
  pintarNotificaciones();
  if (vistaActual === 'perfil') renderPerfil();
}
/* Identificador de "Mi casa" en el mapa */
function marcarMisCasas(){
  capaMisCasas.clearLayers();
  misCuentas.forEach(x => {
    const l = capas.get(x.id); if (!l) return;
    const centro = l.getBounds ? l.getBounds().getCenter() : l.getLatLng();
    if (l.fila.geometria && l.fila.geometria.type === 'Polygon')
      L.geoJSON(l.fila.geometria, {interactive:false, style:{color:'#F2B705', weight:4, fill:false, dashArray:'6 4'}}).addTo(capaMisCasas);
    L.marker(centro, {interactive:false, keyboard:false, zIndexOffset:900,
      icon:L.divIcon({className:'mi-casa', html:`<span>🏠 ${misCuentas.length > 1 ? esc(nombreElemento(l.fila)) : 'Mi casa'}</span>`, iconSize:null})}).addTo(capaMisCasas);
  });
  const ley = $('#leyMiCasa'); if (ley) ley.hidden = !misCuentas.length;
}
function tarjetaCuenta(x){
  const c = calcularCuenta(x), t = x.tarifa, red = infoRedCasa(x.id), l = capas.get(x.id);
  const corte = corteActivoDe(x), clase = clasificarCasa(x, c);
  const paz = c.aplica && c.saldo <= 0 && !corte;
  const unidades = t && t.modo === 'nucleo' ? `${x.nucleos} ${x.nucleos === 1 ? 'núcleo' : 'núcleos'} × ${dinero(t.monto)}`
    : t && t.modo === 'persona' ? `${x.personas} ${x.personas === 1 ? 'persona' : 'personas'} × ${dinero(t.monto)}` : 'monto fijo por casa';
  return `<article class="tarjeta cuenta-casa" data-casa="${esc(x.id)}">
    <div class="cintillo ${corte && corte.estado === 'cortado' ? 'cortado' : paz ? 'paz' : c.saldo > 0 ? 'debe' : 'neutro'}">${corte && corte.estado === 'cortado' ? '🚱 SERVICIO SUSPENDIDO' : paz ? '✓ PAZ Y SALVO' : c.saldo > 0 ? `Saldo pendiente: ${esc(dinero(c.saldo))}` : 'Sin cobros registrados'}</div>
    <header><h2>${esc(l ? nombreElemento(l.fila) : 'Casa ' + (x.numero || ''))}</h2><span class="fila">${etiquetaClase(clase)}${x.exonerada ? '<span class="pill nada">Exonerada</span>' : ''}</span></header>
    ${corte ? `<div class="bloque corte ${corte.estado}"><b>${corte.estado === 'cortado' ? '🚱 Servicio de agua suspendido' : '⚠️ Aviso de corte de agua'}</b>
      <p>${corte.estado === 'cortado'
        ? `Desde el ${esc(fechaCorta(corte.cortado_en))}. Las cuotas se siguen cobrando cada mes. Para reincorporar el servicio, ponte al día o haz un arreglo de pago con la administración.`
        : `Tienes ${corte.meses} ${corte.meses === 1 ? 'mes' : 'meses'} de atraso. Paga o haz un arreglo de pago antes del <b>${esc(fechaCorta(corte.fecha_limite))}</b> para evitar el corte.`}</p></div>` : ''}
    <dl class="datos-cuenta">
      <dt>Tarifa</dt><dd>${x.especial ? 'Cuota especial' : esc(t ? t.nombre : 'Sin tarifa')}${!x.especial && t ? `<small>${esc(unidades)}</small>` : ''}</dd>
      <dt>Cuota mensual</dt><dd><b>${esc(dinero(x.cuota_mensual))}</b></dd>
      <dt>Estado</dt><dd>${paz ? (c.saldo < 0 ? `Al día, con ${esc(dinero(-c.saldo))} a favor` : 'Al día') : c.saldo > 0 ? (c.atraso ? `${c.atraso} ${c.atraso === 1 ? 'mes' : 'meses'} de atraso` : 'Pendiente la cuota de este mes') : '—'}</dd>
      <dt>Último pago</dt><dd>${x.pagos && x.pagos.length ? `${esc(dinero(x.pagos[0].monto))} · ${esc(fechaCorta(x.pagos[0].fecha))}` : 'Sin pagos registrados'}</dd>
    </dl>
    ${c.pendientes.length ? `<div class="bloque debe"><b>Por pagar</b><div class="chips">${c.pendientes.slice(0, 12).map(p => `<span class="chip">${esc(p.tipo === 'cuota' ? mesNombre(p.periodo, true) : p.concepto)} · ${esc(dinero(p.falta))}</span>`).join('')}${c.pendientes.length > 12 ? `<span class="chip">y ${c.pendientes.length - 12} más</span>` : ''}</div></div>` : ''}
    ${c.adelanto.length ? `<div class="bloque adelanto"><b>💚 Pagado por adelantado hasta ${esc(mesNombre(c.adelanto[c.adelanto.length - 1]))}</b>
      <p>Tienes ${c.adelanto.length} ${c.adelanto.length === 1 ? 'mes' : 'meses'} adelantados (${esc(c.adelanto.map(m => mesNombre(m, true)).join(', '))}). Cada mes la cuota se descuenta sola con el valor de tu tarifa.</p></div>` : ''}
    ${c.arreglo ? `<div class="bloque arreglo ${c.arreglo.atrasado ? 'atrasado' : ''}"><b>🤝 Arreglo de pago ${c.arreglo.atrasado ? '· atrasado' : '· al día'}</b>
      <p>Deuda acordada ${esc(dinero(c.arreglo.deuda))} en ${c.arreglo.cuotas} cuotas de ${esc(dinero(c.arreglo.monto_cuota))}, además de la cuota mensual.</p>
      <div class="progreso"><i style="width:${Math.round(c.arreglo.avance / Number(c.arreglo.deuda) * 100)}%"></i></div>
      <p class="nota">Llevas ${c.arreglo.cubiertas} de ${c.arreglo.cuotas} cuotas${c.arreglo.proxima ? ` · próxima: ${esc(mesNombre(c.arreglo.proxima))}` : ' · ¡completado!'}</p></div>` : ''}
    ${red ? `<div class="bloque red"><b>🚰 Tu conexión de agua</b>
      <p>${red.lineas.length ? 'Recibe agua de: ' + esc(red.lineas.join(', ')) : 'Tu casa todavía no aparece conectada a una tubería en el mapa.'}</p>
      ${red.mismaLinea.length ? `<p>Casas conectadas a tu misma línea (${red.mismaLinea.length}): ${esc(red.mismaLinea.slice(0, 15).join(', '))}${red.mismaLinea.length > 15 ? '…' : ''}</p>` : ''}
      ${red.abajo.length ? `<p>Casas que reciben agua a través de tu casa: ${esc(red.abajo.slice(0, 15).join(', '))}${red.abajo.length > 15 ? '…' : ''}</p>` : ''}</div>`
      : '<div class="bloque red"><b>🚰 Tu conexión de agua</b><p>Tu casa todavía no aparece conectada a una tubería en el mapa.</p></div>'}
    ${x.pagos && x.pagos.length ? `<details class="pagos-vecino"><summary>Últimos pagos (${Math.min(x.pagos.length, 10)})</summary><ul>${x.pagos.slice(0, 10).map(p =>
      `<li><span>${esc(fechaCorta(p.fecha))} · Recibo N.º ${String(p.recibo || '').padStart(6, '0')}<small>${esc(METODOS_PAGO[p.metodo] || '')}</small></span><b>${esc(dinero(p.monto))}</b></li>`).join('')}</ul></details>` : ''}
    <div class="fila"><button class="btn" data-ver-casa="${esc(x.id)}">Ver en el mapa</button></div>
  </article>`;
}
function renderCuentas(){
  const cont = $('#pfCuentas'); if (!cont) return;
  if (!sesion){ cont.innerHTML = ''; return; }
  pintarNotificaciones();
  pintarHero();
  $('#pfCuentasTitulo').textContent = misCuentas.length > 1 ? 'Mis casas' : 'Mi casa';
  cont.innerHTML = misCuentas.length ? misCuentas.map(tarjetaCuenta).join('')
    : '<p class="vacio">Todavía no tienes una casa vinculada a tu cuenta. Si eres representante de una casa, pide a la administración que la vincule.</p>';
  cont.querySelectorAll('[data-ver-casa]').forEach(b => b.addEventListener('click', () => {
    const l = capas.get(b.dataset.verCasa); if (!l) return;
    irA('mapa');
    setTimeout(() => { if (l.getBounds) map.fitBounds(l.getBounds(), {maxZoom:19, padding:[60, 60]}); else map.setView(l.getLatLng(), 19); }, 80);
  }));
}

/* =====================================================================
   CORTES, NOTIFICACIONES Y CLASIFICACIÓN DEL VECINO
   ===================================================================== */
const CLASIFICACION = {
  excelencia:{txt:'Excelencia', icono:'⭐', desc:'Tienes meses pagados por adelantado. ¡Gracias!'},
  aldia:{txt:'Al Día', icono:'✓', desc:'Tus pagos están al día.'},
  atencion:{txt:'Atención', icono:'!', desc:'Tienes una deuda pendiente o un arreglo de pago.'},
  intervencion:{txt:'Intervención', icono:'⚠', desc:'Superaste los meses de deuda permitidos: hay un aviso o un corte de agua.'}
};
const PRIORIDAD_CLASE = ['excelencia', 'aldia', 'atencion', 'intervencion'];
const corteActivoDe = x => (x.cortes || []).find(k => k.estado === 'notificado' || k.estado === 'cortado') || null;
/* Misma regla que la administración */
function clasificarCasa(x, c){
  if (!c.aplica) return null;
  const tol = Number(x.meses_para_corte) || 2;
  if (corteActivoDe(x) || c.atraso > tol) return 'intervencion';
  if (c.arreglo || c.atraso >= 1) return 'atencion';
  if (c.adelanto.length >= 1) return 'excelencia';
  return 'aldia';
}
function clasificacionGeneral(){
  const cls = misCuentas.map(x => clasificarCasa(x, calcularCuenta(x))).filter(Boolean);
  if (!cls.length) return null;
  if (cls.every(k => k === 'excelencia')) return 'excelencia';
  return cls.filter(k => k !== 'excelencia').reduce((a, k) => PRIORIDAD_CLASE.indexOf(k) > PRIORIDAD_CLASE.indexOf(a) ? k : a, 'aldia');
}
const etiquetaClase = k => k ? `<span class="clase clase-${k}"><i>${CLASIFICACION[k].icono}</i>${CLASIFICACION[k].txt}</span>` : '';

/* Notificaciones: cortes, arreglos, pagos pendientes, adelantos por terminar y reportes respondidos */
const TIPOS_AVISO = {
  corte:{txt:'Corte de agua', icono:'🚱', cls:'grave'}, aviso:{txt:'Aviso de corte', icono:'⚠️', cls:'grave'},
  arreglo:{txt:'Arreglo de pago', icono:'🤝', cls:'medio'}, deuda:{txt:'Pago pendiente', icono:'💳', cls:'medio'},
  adelanto:{txt:'Pago adelantado', icono:'💚', cls:'info'}, reporte:{txt:'Tu reporte', icono:'📝', cls:'info'},
  ok:{txt:'Servicio', icono:'✅', cls:'ok'}
};
function notificaciones(){
  const lista = [], hoy = mesHoy(), hace = dias => Date.now() - dias * 864e5;
  misCuentas.forEach(x => {
    const l = capas.get(x.id), casa = l ? nombreElemento(l.fila) : 'Casa ' + (x.numero || ''), c = calcularCuenta(x);
    const corte = corteActivoDe(x);
    (x.cortes || []).forEach(k => {
      if (k.estado === 'notificado') lista.push({activa:true, tipo:'aviso', cuando:k.notificado_en, casa,
        texto:`${casa} tiene ${k.meses} ${k.meses === 1 ? 'mes' : 'meses'} de atraso (${dinero(k.deuda)}). Paga o haz un arreglo de pago antes del ${fechaCorta(k.fecha_limite)} para evitar el corte del servicio.`});
      else if (k.estado === 'cortado') lista.push({activa:true, tipo:'corte', cuando:k.cortado_en, casa,
        texto:`El servicio de ${casa} está suspendido desde el ${fechaCorta(k.cortado_en)}. Las cuotas se siguen generando cada mes; ponte al día o haz un arreglo de pago para reincorporarlo.`});
      else if (k.estado === 'reincorporado' && new Date(k.cerrado_en) > hace(30)) lista.push({activa:false, tipo:'ok', cuando:k.cerrado_en, casa,
        texto:`El servicio de agua de ${casa} se reincorporó el ${fechaCorta(k.cerrado_en)}.`});
      else if (k.estado === 'atendido' && new Date(k.cerrado_en) > hace(30)) lista.push({activa:false, tipo:'ok', cuando:k.cerrado_en, casa,
        texto:`El aviso de corte de ${casa} quedó atendido. ¡Gracias!`});
    });
    if (c.arreglo){
      const a = c.arreglo;
      lista.push({activa:a.atrasado || a.proxima === hoy, tipo:'arreglo', cuando:new Date().toISOString(), casa,
        texto:a.atrasado ? `Tu arreglo de pago de ${casa} está atrasado: te toca la cuota de ${mesNombre(a.proxima)} (${dinero(a.monto_cuota)}), además de la cuota mensual.`
          : a.proxima ? `Arreglo de pago de ${casa}: llevas ${a.cubiertas} de ${a.cuotas} cuotas. La próxima es la de ${mesNombre(a.proxima)} (${dinero(a.monto_cuota)}).`
          : `¡Completaste el arreglo de pago de ${casa}!`});
    } else if (!corte && c.saldo > 0){
      lista.push({activa:true, tipo:'deuda', cuando:new Date().toISOString(), casa,
        texto:c.atraso ? `${casa} tiene ${c.atraso} ${c.atraso === 1 ? 'mes' : 'meses'} de atraso: debes ${dinero(c.saldo)}.`
          : `La cuota de ${mesNombre(hoy)} de ${casa} (${dinero(c.saldo)}) está pendiente.`});
    }
    if (c.adelanto.length){
      const ultimo = c.adelanto[c.adelanto.length - 1], quedan = c.adelanto.length;
      lista.push({activa:quedan <= 1, tipo:'adelanto', cuando:new Date().toISOString(), casa,
        texto:quedan <= 1 ? `Tu pago adelantado de ${casa} cubre hasta ${mesNombre(ultimo)}. Pronto te tocará pagar de nuevo.`
          : `${casa} está pagada por adelantado hasta ${mesNombre(ultimo)} (${quedan} meses).`});
    }
  });
  (misReportes || []).forEach(r => {
    const cuando = r.actualizado_en || r.created_at;
    if (r.estado !== 'nuevo' && cuando && new Date(cuando) > hace(14))
      lista.push({activa:false, tipo:'reporte', cuando, casa:'',
        texto:`Tu reporte «${r.tipo}» está ${r.estado === 'atendido' ? 'atendido' : r.estado === 'en_revision' ? 'en revisión' : 'cerrado'}.${r.respuesta ? ' Respuesta: ' + r.respuesta : ''}`});
  });
  const orden = ['corte', 'aviso', 'arreglo', 'deuda', 'adelanto', 'reporte', 'ok'];
  return lista.sort((a, b) => (b.activa - a.activa) || orden.indexOf(a.tipo) - orden.indexOf(b.tipo) || String(b.cuando).localeCompare(String(a.cuando)));
}
function pintarNotificaciones(){
  const activas = notificaciones().filter(n => n.activa).length;
  $('#btnAvisos').hidden = !sesion;
  document.querySelectorAll('[data-cuenta-avisos], #avisosCuenta').forEach(b => { b.textContent = activas; b.hidden = !activas; });
  $('#btnAvisos').classList.toggle('con-avisos', !!activas);
  $('#btnAvisos').title = activas ? `${activas} ${activas === 1 ? 'notificación' : 'notificaciones'}` : 'Notificaciones';
}
function renderNotificaciones(){ pintarNotificaciones(); }
function abrirAvisos(){
  const lista = notificaciones(), activas = lista.filter(n => n.activa);
  const item = n => { const t = TIPOS_AVISO[n.tipo];
    return `<div class="notif ${t.cls} ${n.activa ? 'activa' : ''}"><span class="ic" aria-hidden="true">${t.icono}</span>
      <div><b>${t.txt}${n.casa ? ' · ' + esc(n.casa) : ''}</b><p>${esc(n.texto)}</p></div></div>`; };
  $('#avCuerpo').innerHTML = !activas.length
    ? `<div class="al-dia"><div class="ic" aria-hidden="true">✓</div><h3>¡Estás al día!</h3><p>No tienes notificaciones pendientes.</p></div>
       ${lista.length ? `<h4 class="av-sub">Información</h4>${lista.map(item).join('')}` : ''}`
    : `<p class="av-resumen">Tienes <b>${activas.length} ${activas.length === 1 ? 'notificación' : 'notificaciones'}</b> de: ${esc([...new Set(activas.map(n => TIPOS_AVISO[n.tipo].txt.toLowerCase()))].join(', '))}.</p>
       ${activas.map(item).join('')}
       ${lista.length > activas.length ? `<h4 class="av-sub">Información</h4>${lista.filter(n => !n.activa).map(item).join('')}` : ''}`;
  $('#dlgAvisos').showModal();
}
$('#btnAvisos').addEventListener('click', abrirAvisos);
document.querySelectorAll('[data-abrir-avisos]').forEach(b => b.addEventListener('click', abrirAvisos));

/* --- Perfil (estilo aplicación) --- */
let ocultarSaldo = (() => { try { return localStorage.getItem('acu-ocultar-saldo') === '1'; } catch (e){ return false; } })();
function pintarHero(){
  const cuentas = misCuentas.map(x => ({x, c:calcularCuenta(x)}));
  // Lo que se debe (sumando solo las casas con deuda); si no se debe nada, el saldo a favor
  const debe = r2(cuentas.reduce((s, y) => s + Math.max(0, y.c.saldo), 0)), favor = r2(cuentas.reduce((s, y) => s + Math.max(0, -y.c.saldo), 0));
  const saldo = debe > 0 ? debe : -favor, g = clasificacionGeneral();
  const nombre = (perfil && perfil.nombre) || '';
  $('#pfHola').textContent = nombre ? `Hola, ${nombre.split(' ')[0]}` : 'Hola';
  $('#pfClase').innerHTML = g ? etiquetaClase(g) : '';
  $('#pfSaldoTitulo').textContent = !cuentas.length ? 'Aún no tienes casas vinculadas' : saldo > 0 ? 'Saldo pendiente de mis casas' : saldo < 0 ? 'Saldo a favor' : 'Saldo de mis casas';
  $('#pfSaldo').textContent = !cuentas.length ? '—' : ocultarSaldo ? '•••••' : dinero(Math.abs(saldo));
  $('#pfOjo').setAttribute('aria-pressed', String(ocultarSaldo));
  $('#pfOjo').classList.toggle('oculto', ocultarSaldo);
  const cortada = cuentas.some(y => (corteActivoDe(y.x) || {}).estado === 'cortado');
  $('#pfEstadoGeneral').innerHTML = !cuentas.length ? 'Pide a la administración que vincule tu casa.'
    : cortada ? '🚱 Tienes una casa con el servicio suspendido' : saldo <= 0 ? '✓ PAZ Y SALVO' : g ? esc(CLASIFICACION[g].desc) : '';
  $('#pfEstadoGeneral').className = 'pf-estado ' + (cortada ? 'mal' : saldo <= 0 && cuentas.length ? 'paz' : '');
  // Resumen del año
  const anio = String(new Date().getFullYear());
  const pagado = r2(cuentas.reduce((s, y) => s + (y.x.pagos || []).filter(p => String(p.fecha).startsWith(anio)).reduce((t, p) => t + Number(p.monto), 0), 0));
  const porPagar = r2(cuentas.reduce((s, y) => s + Math.max(0, y.c.saldo), 0));
  $('#pfResumenAnio').textContent = 'Año ' + anio;
  $('#pfPagado').textContent = ocultarSaldo ? '•••' : dinero(pagado);
  $('#pfPorPagar').textContent = ocultarSaldo ? '•••' : dinero(porPagar);
  $('#pfPorPagar').classList.toggle('rojo', porPagar > 0);
  $('#pfCuotaTotal').textContent = dinero(cuentas.reduce((s, y) => s + Number(y.x.cuota_mensual || 0), 0));
  // Tarjetas deslizables de las casas
  $('#pfCarrusel').hidden = !cuentas.length;
  $('#pfMini').innerHTML = cuentas.map(({x, c}) => {
    const l = capas.get(x.id), corte = corteActivoDe(x), cls = clasificarCasa(x, c);
    const est = corte && corte.estado === 'cortado' ? ['mal', 'Servicio suspendido'] : c.saldo > 0 ? ['debe', 'Debe ' + dinero(c.saldo)] : ['paz', c.saldo < 0 ? 'Adelantado' : 'Paz y salvo'];
    return `<button class="pf-mini ${est[0]}" data-ir-tarjeta="${esc(x.id)}">
      <span class="pf-mini-ic" aria-hidden="true">🏠</span>
      <span class="pf-mini-txt"><b>${esc(l ? nombreElemento(l.fila) : 'Casa ' + (x.numero || ''))}</b><small>${esc(est[1])}</small></span>
      ${cls ? `<span class="pf-mini-clase">${etiquetaClase(cls)}</span>` : ''}</button>`;
  }).join('');
  $('#pfMini').querySelectorAll('[data-ir-tarjeta]').forEach(b => b.addEventListener('click', () => {
    const t = document.querySelector(`.cuenta-casa[data-casa="${b.dataset.irTarjeta}"]`);
    if (t){ t.scrollIntoView({behavior:'smooth', block:'start'}); t.classList.add('resaltada'); setTimeout(() => t.classList.remove('resaltada'), 1400); }
  }));
}
$('#pfOjo').addEventListener('click', () => {
  ocultarSaldo = !ocultarSaldo;
  try { localStorage.setItem('acu-ocultar-saldo', ocultarSaldo ? '1' : '0'); } catch (e){}
  pintarHero();
});
document.querySelectorAll('[data-ir-casas]').forEach(b => b.addEventListener('click', () => {
  if (vistaActual !== 'perfil') irA('perfil');
  setTimeout(() => $('#pfCuentasBox').scrollIntoView({behavior:'smooth', block:'start'}), 60);
}));
/* Cabecera de las ventanas de perfil: inicial, nombre y casas */
function cabeceraPerfil(){
  const nombre = (perfil && perfil.nombre) || (sesion && sesion.user.email) || '';
  const casas = misCuentas.map(x => { const l = capas.get(x.id); return l ? nombreElemento(l.fila) : 'Casa ' + (x.numero || ''); });
  document.querySelectorAll('[data-mp-avatar]').forEach(e => { e.textContent = (nombre.trim().charAt(0) || '?').toUpperCase(); });
  document.querySelectorAll('[data-mp-nombre]').forEach(e => { e.textContent = (perfil && perfil.nombre) || 'Mi perfil'; });
  document.querySelectorAll('[data-mp-sub]').forEach(e => { e.textContent = casas.length ? 'Representante de ' + casas.join(', ') : 'Vecino'; });
  document.querySelectorAll('[data-aviso-temporal]').forEach(e => { e.hidden = !(perfil && perfil.debe_cambiar_clave); });
}
document.querySelectorAll('[data-abrir-datos]').forEach(b => b.addEventListener('click', () => {
  $('#menuCuenta').hidden = true;
  renderPerfil(); cabeceraPerfil(); $('#pfDatosMsg').hidden = true; $('#dlgDatos').showModal();
}));
document.querySelectorAll('[data-abrir-clave]').forEach(b => b.addEventListener('click', () => {
  $('#menuCuenta').hidden = true;
  if ($('#dlgDatos').open) $('#dlgDatos').close();
  cabeceraPerfil(); AcuClave.limpiar($('#dlgClave')); $('#pfClaveMsg').hidden = true; $('#dlgClave').showModal();
}));
document.querySelectorAll('[data-abrir-pagos]').forEach(b => b.addEventListener('click', () => {
  const pagos = misCuentas.flatMap(x => { const l = capas.get(x.id); return (x.pagos || []).map(p => ({...p, casa:l ? nombreElemento(l.fila) : 'Casa ' + (x.numero || '')})); })
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  $('#pgCuerpo').innerHTML = pagos.length ? `<ul class="lista-pagos">${pagos.slice(0, 40).map(p => `<li>
      <span class="ic" aria-hidden="true">🧾</span><span class="txt"><b>${esc(p.casa)} · Recibo N.º ${String(p.recibo || '').padStart(6, '0')}</b>
      <small>${esc(fechaCorta(p.fecha))} · ${esc(METODOS_PAGO[p.metodo] || '')}</small></span><b class="monto">${esc(dinero(p.monto))}</b></li>`).join('')}</ul>`
    : '<p class="vacio">Todavía no hay pagos registrados en tus casas.</p>';
  $('#dlgPagos').showModal();
}));

/* --- Mi perfil --- */
function renderPerfil(){
  renderCuentas();
  $('#pfCuentasBox').hidden = !sesion;
  $('#pfSinSesion').hidden = !!sesion;
  $('#pfContenido').hidden = !sesion;
  $('#pfAviso').hidden = !(perfil && perfil.debe_cambiar_clave);
  if (!sesion) return;
  $('#pfCorreo').textContent = sesion.user.email || '';
  const casa = perfil && perfil.casa_id && capas.get(perfil.casa_id);
  $('#pfCasa').textContent = misCuentas.length ? misCuentas.map(x => { const l = capas.get(x.id); return l ? nombreElemento(l.fila) : 'Casa ' + (x.numero || ''); }).join(', ')
    : casa ? nombreElemento(casa.fila) : (perfil && perfil.numero_casa ? 'Casa ' + perfil.numero_casa : 'sin casa vinculada');
  if (document.activeElement !== $('#pfNombre')) $('#pfNombre').value = (perfil && perfil.nombre) || '';
  if (document.activeElement !== $('#pfCelular')) $('#pfCelular').value = (perfil && perfil.celular) || '';
}

$('#pfGuardar').addEventListener('click', async () => {
  const {data, error} = await sb.rpc('actualizar_mi_perfil', {p_nombre:$('#pfNombre').value, p_celular:$('#pfCelular').value});
  if (error){ mensajeForm('#pfDatosMsg', explicarError(error), false); return; }
  mensajeForm('#pfDatosMsg', data.mensaje, data.ok);
  if (data.ok && perfil){ perfil.nombre = $('#pfNombre').value.trim(); perfil.celular = $('#pfCelular').value.trim(); pintarCuenta(); }
});
$('#pfCambiar').addEventListener('click', async () => {
  const a = $('#pfClave').value, b = $('#pfClave2').value;
  if (a.length < 8){ mensajeForm('#pfClaveMsg', 'La contraseña debe tener al menos 8 caracteres.', false); return; }
  if (a !== b){ mensajeForm('#pfClaveMsg', 'Las dos contraseñas no coinciden.', false); return; }
  const btn = $('#pfCambiar'); btn.disabled = true;
  const {error} = await sb.auth.updateUser({password:a});
  btn.disabled = false;
  if (error){
    mensajeForm('#pfClaveMsg', /reauthent|recent/i.test(error.message) ? 'Por seguridad, cierra sesión, vuelve a entrar e inténtalo de nuevo.'
      : /same|different/i.test(error.message) ? 'La contraseña nueva debe ser distinta de la actual.' : 'No se pudo cambiar: ' + error.message, false);
    return;
  }
  await sb.rpc('marcar_clave_cambiada');
  if (perfil) perfil.debe_cambiar_clave = false;
  $('#pfClave').value = ''; $('#pfClave2').value = '';
  mensajeForm('#pfClaveMsg', 'Listo, contraseña cambiada. Úsala la próxima vez que entres.', true);
  renderPerfil();
});

/* ---------- WhatsApp ---------- */
function waURL(){
  const dig = String(config.whatsapp || '').replace(/\D/g, '');
  if (!config.whatsapp_activo || dig.length < 8) return '';
  return `https://wa.me/${dig}${config.whatsapp_mensaje ? '?text=' + encodeURIComponent(config.whatsapp_mensaje) : ''}`;
}
/* Con la red oculta, no se muestran los controles ni la leyenda de tuberías, llaves y conectores */
function pintarRedVisible(){
  const oculta = redOculta();
  document.querySelectorAll('[data-capa="tuberia"], [data-capa="llave"]').forEach(c => { const l = c.closest('label'); if (l) l.hidden = oculta; });
  document.querySelectorAll('[data-leyenda-red]').forEach(e => { e.hidden = oculta; });
}
function pintarConfig(){
  const nombre = config.nombre || 'Acueducto';
  $('#nombreAcu').textContent = nombre;
  $('#pieNombre').textContent = '© ' + new Date().getFullYear() + ' ' + nombre;
  document.title = nombre + ': estado del servicio';
  const url = waURL(), wa = $('#whatsapp');
  wa.hidden = !url;
  if (url) wa.href = url;
}

/* =====================================================================
   CARGA Y TIEMPO REAL
   ===================================================================== */
async function cargar(){
  const [cfg, filas, lista, efs, cats] = await Promise.all([
    sb.from('configuracion').select('*').eq('id', 1).maybeSingle(),
    Acu.traerTodo(sb, 'mapa_publico'),
    Acu.traerTodo(sb, 'incidencias_publicas').catch(e => { console.warn('Sin incidencias públicas:', e.message); return []; }),
    sb.from('efectos_publicos').select('*').then(r => r.data || [], () => []),
    sb.from('categorias_casa').select('id,nombre,color').then(r => r.data || [], () => [])
  ]);
  efectos = efs; categorias = cats;
  if (cfg.data){ config = cfg.data; pintarConfig(); pintarRedVisible(); map.ajustarFondos(config.ajuste_fondos || {}); if (mapaRep) mapaRep.ajustarFondos(config.ajuste_fondos || {}); }
  const vistos = new Set(filas.map(r => r.id));
  [...capas.keys()].forEach(id => { if (!vistos.has(id)) quitar(id); });
  filas.forEach(agregar);
  incsTodas.clear();
  lista.forEach(i => incsTodas.set(i.id, i));
  recalcular();
  dibujarFlechas();
  if (misCuentas.length) marcarMisCasas();
  if (sesion && vistaActual === 'perfil') cargarMisCuentas();
  $('#actualizado').textContent = 'Actualizado a las ' + new Date().toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'});
  if (vistaActual === 'mapa') ajustarMapa();
}
function pintarVivo(on){
  const v = $('#vivo');
  v.classList.toggle('off', !on);
  v.querySelector('span').textContent = on ? 'En vivo' : 'Sin conexión en vivo; se actualiza cada 2 minutos';
}
function suscribir(){
  const canal = sb.channel('sitio-publico')
    .on('postgres_changes', {event:'*', schema:'public', table:'mapa_publico'}, p => {
      if (p.eventType === 'DELETE') quitar(p.old.id); else agregar(p.new);
      recalcularPronto(); flechasPronto();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'efectos_publicos'}, p => {
      if (p.eventType === 'DELETE') efectos = efectos.filter(e => e.id !== p.old.id);
      else { const i = efectos.findIndex(e => e.id === p.new.id); if (i >= 0) efectos[i] = p.new; else efectos.push(p.new); }
      recalcularPronto();
    })
    .on('postgres_changes', {event:'*', schema:'public', table:'incidencias_publicas'}, p => {
      if (p.eventType === 'DELETE') incsTodas.delete(p.old.id); else incsTodas.set(p.new.id, p.new);
      recalcularPronto();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'configuracion'}, p => {
      if (!p.new) return;
      const cambioRed = !!p.new.ocultar_red_vecinos !== redOculta();
      config = p.new; pintarConfig(); pintarRedVisible(); map.ajustarFondos(config.ajuste_fondos || {});
      if (cambioRed) cargar(); else renderVistaActual();
    });
  if (sesion) canal.on('postgres_changes', {event:'*', schema:'public', table:'reportes'}, () => cargarMisReportes());
  canal.subscribe(status => pintarVivo(status === 'SUBSCRIBED'));
}

(async () => {
  try { sb = Acu.cliente(); }
  catch (e){ $('#cargando div').textContent = e.message; return; }
  try {
    const {data:{session}} = await sb.auth.getSession();
    sesion = session;
    // Para ver la página hay que iniciar sesión con una cuenta activa
    if (!sesion){ location.replace('assets/pages/auth/auth.html'); return; }
    const {data} = await sb.from('perfiles').select('*').eq('id', sesion.user.id).maybeSingle();
    perfil = data || null;
    if (!perfil || perfil.estado !== 'activo'){ location.replace('assets/pages/auth/auth.html'); return; }
    AcuSesion.vigilarInactividad(sb, {destino:'assets/pages/auth/auth.html'});
    pintarCuenta();
    await cargar();
    router();
    $('#cargando').hidden = true;
    suscribir();
    if (sesion){ cargarMisReportes(); cargarMisCuentas(); }
  } catch (err){
    console.error(err);
    $('#cargando div').innerHTML = 'No se pudo cargar la información.<br><small>Revisa tu conexión; reintentaremos en unos segundos.</small>';
    setTimeout(() => location.reload(), 20000);
    return;
  }
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') location.replace('assets/pages/auth/auth.html'); });
  if (window.__PRUEBAS) window.__pub = {map, capas, red};   // solo para pruebas automáticas
  setInterval(() => cargar().catch(() => {}), 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cargar().catch(() => {}); });
})();
})();
