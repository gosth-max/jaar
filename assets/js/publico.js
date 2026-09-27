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
    else layer.setStyle({color:col, weight:d.clase === 'acometida' ? 3.5 : 5.5, opacity:op, lineCap:'round', dashArray:null});
    marcar(layer, 'con-incidencia', true);
    if (r.tipo === 'sector'){ Acu.ponerEtiquetaSector(layer, d, textoIncs(r.id)); if (layer._map) layer.bringToBack(); }
    return;
  }
  marcar(layer, 'con-incidencia', false);
  const col = r.tipo === 'tuberia' ? Acu.COLOR_TUBERIA : (r.color || (TIPOS[r.tipo] || TIPOS.sin).color);
  if (r.tipo === 'sector' && esPol){ Acu.estiloSector(layer, col, d, false); Acu.ponerEtiquetaSector(layer, d, textoIncs(r.id)); return; }
  if (esPunto){
    const cerrada = r.tipo === 'llave' && d.estado === 'cerrada';
    layer.setStyle({radius:r.tipo === 'llave' ? 8 : 6, color:cerrada ? col : '#fff', weight:cerrada ? 3 : 2, fillColor:col, fillOpacity:cerrada ? 0.15 : 0.95});
  } else if (esPol) layer.setStyle({color:col, weight:1.5, opacity:1, fillColor:col, fillOpacity:0.5, dashArray:null});
  else layer.setStyle({color:col, weight:r.tipo === 'tuberia' ? (d.clase === 'acometida' ? 3 : 5) : 3, opacity:.95, lineCap:'round', dashArray:null});
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
    : Acu.capaDesdeGeom(r.geometria);
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

function recalcular(){
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
  const d = l.fila.datos || {}, activo = !!d.activo, inc = textoIncs(l.fila.id);
  const muestra = inc ? ROJO : activo ? (l.fila.color || TIPOS.sector.color) : Acu.SIN_FLUJO.relleno;
  return `<li><button data-sector="${i}"><i class="muestra" style="background:${esc(muestra)}"></i>
    <span class="nom">${esc(d.nombre || 'Sector sin nombre')}<small>${esc(inc ? '⚠ ' + inc : Acu.desde(d.activoDesde))}</small></span>
    <span class="pill ${activo ? 'con' : 'sin'}">${activo ? 'Con agua' : 'Sin agua'}</span></button></li>`;
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
  const lista = abiertas().filter(i => capas.has(i.forma_id)).sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en)));
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
const RENDER = {inicio:renderInicio, calendario:renderCalendario, reportar:renderReportar};
function router(){
  let ruta = location.hash.replace(/^#\/?/, '') || 'inicio';
  let abrirReg = false;
  if (ruta === 'registro'){ ruta = 'reportar'; abrirReg = true; }
  if (!['inicio', 'mapa', 'calendario', 'reportar'].includes(ruta)) ruta = 'inicio';
  irA(ruta, true);
  if (abrirReg){ history.replaceState(null, '', '#/reportar'); abrirRegistro(); }
}
function irA(v, desdeRouter){
  if (!desdeRouter && location.hash !== '#/' + v) history.pushState(null, '', '#/' + v);
  const cambio = vistaActual !== v;
  if (v !== 'mapa') salirHistorico();
  vistaActual = v;
  if (cambio){
    document.querySelectorAll('[data-vista]').forEach(s => { s.hidden = s.dataset.vista !== v; });
    document.querySelectorAll('#nav a').forEach(a => { if (a.dataset.ruta === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
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
  const act = abiertas().filter(i => capas.has(i.forma_id)).sort((a, b) => String(b.creada_en).localeCompare(String(a.creada_en)));
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
$('#btnSalir').addEventListener('click', async () => { await sb.auth.signOut(); location.hash = '#/inicio'; location.reload(); });

/* --- Enviar un reporte --- */
let mapaRep = null, marcaRep = null, puntoRep = null, abiertoRepEn = Date.now(), misReportes = [];
function renderReportar(){
  $('#repSinSesion').hidden = !!sesion;
  $('#repSinAcceso').hidden = !sesion || puedeReportar();
  $('#repConSesion').hidden = !(sesion && puedeReportar());
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
  capas.forEach(l => {
    if (l.fila.tipo === 'tuberia') L.geoJSON(l.fila.geometria, {style:{color:Acu.COLOR_TUBERIA, weight:3, opacity:.9}, interactive:false}).addTo(mapaRep);
    if (l.fila.tipo === 'casa') L.geoJSON(l.fila.geometria, {style:{color:'#3B6EA8', weight:1, fillOpacity:.35}, interactive:false,
      pointToLayer:(f, ll) => L.circleMarker(ll, {radius:5})}).addTo(mapaRep);
  });
  const miCasa = perfil && perfil.casa_id && capas.get(perfil.casa_id);
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

/* --- Solicitar una cuenta --- */
const CLAVE_ESPERA_REG = 'acu-registro-espera';
let abiertoRegEn = 0;
function abrirRegistro(){
  if (sesion){ aviso('Ya tienes una sesión iniciada.'); return; }
  abiertoRegEn = Date.now();
  $('#regMensaje').hidden = true;
  $('#dlgRegistro').showModal();
  contarEsperaReg();
}
$('#abrirRegistro').addEventListener('click', abrirRegistro);
function esperaRegistro(){ try { return Number(localStorage.getItem(CLAVE_ESPERA_REG)) || 0; } catch (e){ return 0; } }
function contarEsperaReg(){
  const b = $('#regEnviar'), falta = Math.ceil((esperaRegistro() - Date.now()) / 1000);
  if (falta > 0){
    b.disabled = true;
    b.textContent = falta > 3600 ? `Podrás intentar de nuevo en ${Math.ceil(falta / 3600)} h` : falta > 60 ? `Podrás intentar de nuevo en ${Math.ceil(falta / 60)} min` : `Espera ${falta} s`;
    if ($('#dlgRegistro').open) setTimeout(contarEsperaReg, 1000);
  } else { b.disabled = false; b.textContent = 'Enviar solicitud'; }
}
$('#formRegistro').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f).entries());
  if (!f.checkValidity()){ f.reportValidity(); return; }
  if (!d.acepto){ mensajeForm('#regMensaje', 'Debes aceptar la política de privacidad.', false); return; }
  const b = $('#regEnviar'); b.disabled = true; b.textContent = 'Enviando…';
  const {data, error} = await sb.rpc('solicitar_registro', {
    p_nombre:d.nombre, p_celular:d.celular, p_email:d.email, p_numero_casa:d.numero_casa,
    p_trampa:d.sitio_web || '', p_segundos:Math.round((Date.now() - abiertoRegEn) / 1000)
  });
  if (error){ b.disabled = false; b.textContent = 'Enviar solicitud'; mensajeForm('#regMensaje', explicarError(error), false); return; }
  mensajeForm('#regMensaje', data.mensaje, !!data.ok);
  // Tiempo de espera antes de otro intento
  const espera = data.ok ? 600 : (Number(data.esperar) || 0);
  if (espera){ try { localStorage.setItem(CLAVE_ESPERA_REG, String(Date.now() + espera * 1000)); } catch (e2){} }
  if (data.ok) f.reset();
  contarEsperaReg();
});

/* ---------- WhatsApp ---------- */
function waURL(){
  const dig = String(config.whatsapp || '').replace(/\D/g, '');
  if (!config.whatsapp_activo || dig.length < 8) return '';
  return `https://wa.me/${dig}${config.whatsapp_mensaje ? '?text=' + encodeURIComponent(config.whatsapp_mensaje) : ''}`;
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
  const [cfg, filas, lista] = await Promise.all([
    sb.from('configuracion').select('*').eq('id', 1).maybeSingle(),
    Acu.traerTodo(sb, 'mapa_publico'),
    Acu.traerTodo(sb, 'incidencias_publicas').catch(e => { console.warn('Sin incidencias públicas:', e.message); return []; })
  ]);
  if (cfg.data){ config = cfg.data; pintarConfig(); }
  const vistos = new Set(filas.map(r => r.id));
  [...capas.keys()].forEach(id => { if (!vistos.has(id)) quitar(id); });
  filas.forEach(agregar);
  incsTodas.clear();
  lista.forEach(i => incsTodas.set(i.id, i));
  recalcular();
  dibujarFlechas();
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
    .on('postgres_changes', {event:'*', schema:'public', table:'incidencias_publicas'}, p => {
      if (p.eventType === 'DELETE') incsTodas.delete(p.old.id); else incsTodas.set(p.new.id, p.new);
      recalcularPronto();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'configuracion'}, p => { if (p.new){ config = p.new; pintarConfig(); renderVistaActual(); } });
  if (sesion) canal.on('postgres_changes', {event:'*', schema:'public', table:'reportes'}, () => cargarMisReportes());
  canal.subscribe(status => pintarVivo(status === 'SUBSCRIBED'));
}

(async () => {
  try { sb = Acu.cliente(); }
  catch (e){ $('#cargando div').textContent = e.message; return; }
  try {
    const {data:{session}} = await sb.auth.getSession();
    sesion = session;
    if (sesion){
      const {data} = await sb.from('perfiles').select('*').eq('id', sesion.user.id).maybeSingle();
      perfil = data || null;
    }
    pintarCuenta();
    await cargar();
    router();
    $('#cargando').hidden = true;
    suscribir();
    if (sesion) cargarMisReportes();
  } catch (err){
    console.error(err);
    $('#cargando div').innerHTML = 'No se pudo cargar la información.<br><small>Revisa tu conexión; reintentaremos en unos segundos.</small>';
    setTimeout(() => location.reload(), 20000);
    return;
  }
  sb.auth.onAuthStateChange((ev, s) => { if (ev === 'SIGNED_OUT'){ sesion = null; perfil = null; pintarCuenta(); renderVistaActual(); } });
  if (window.__PRUEBAS) window.__pub = {map, capas, red};   // solo para pruebas automáticas
  setInterval(() => cargar().catch(() => {}), 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) cargar().catch(() => {}); });
})();
})();
