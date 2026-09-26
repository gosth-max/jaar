/* =====================================================================
   Funciones compartidas por el mapa público (index.html)
   y la administración (assets/pages/adm/jaar.html).
   ===================================================================== */
(function(){
'use strict';

const TIPOS = {
  casa:    {nombre:'Casa',        color:'#3B6EA8', dibujo:'Polygon'},
  tuberia: {nombre:'Tubería',     color:'#1596C4', dibujo:'Line'},
  llave:   {nombre:'Llave',       color:'#8A4FBF', dibujo:'CircleMarker'},
  sector:  {nombre:'Sector',      color:'#1E88E5', dibujo:'Polygon'},
  sin:     {nombre:'Sin función', color:'#6F7F85'}
};
const SIN_FLUJO = {relleno:'#8C989C', borde:'#5F6D72'};

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

/* ---------- Supabase ---------- */
function cliente(){
  const c = window.ACU_CONFIG || {};
  if (!window.supabase) throw new Error('No se pudo cargar la librería de Supabase. Revisa tu conexión a internet y recarga la página.');
  if (!c.SUPABASE_URL || !c.SUPABASE_KEY) throw new Error('Falta la configuración de Supabase en assets/js/config.js.');
  return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_KEY);
}

async function traerTodo(sb, tabla){
  const out = [], paso = 1000;
  for (let desde = 0; ; desde += paso){
    const {data, error} = await sb.from(tabla).select('*').order('id').range(desde, desde + paso - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < paso) break;
  }
  return out;
}

/* ---------- Mapa base ---------- */
function crearMapa(id, opciones = {}){
  const map = L.map(id, {zoomControl:false, maxZoom:21}).setView([8.6, -80.1], 7);
  L.control.zoom({position:'topleft'}).addTo(map);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {maxZoom:21, maxNativeZoom:19, attribution:'Imágenes &copy; Esri'});
  const calles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom:21, maxNativeZoom:19, attribution:'&copy; colaboradores de OpenStreetMap'});
  sat.addTo(map);
  L.control.layers({'Satélite':sat, 'Calles':calles}, null, {position:'bottomleft'}).addTo(map);

  const Ubicacion = L.Control.extend({
    options:{position:'topleft'},
    onAdd(){
      const b = L.DomUtil.create('button', 'btn-ubic');
      b.title = 'Ir a mi ubicación'; b.setAttribute('aria-label', 'Ir a mi ubicación');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#15323B" stroke-width="2.2"><circle cx="12" cy="12" r="5"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg>';
      L.DomEvent.disableClickPropagation(b);
      b.addEventListener('click', () => map.locate({setView:true, maxZoom:18}));
      return b;
    }
  });
  new Ubicacion().addTo(map);
  map.on('locationerror', () => opciones.aviso && opciones.aviso('No se pudo obtener tu ubicación. Revisa el permiso de ubicación del navegador.'));
  return map;
}

function capaDesdeGeom(g){
  if (!g) return null;
  if (g.type === 'Point') return L.circleMarker([g.coordinates[1], g.coordinates[0]], {radius:8});
  if (['Polygon','LineString','MultiLineString'].includes(g.type))
    return L.GeoJSON.geometryToLayer({type:'Feature', geometry:g, properties:{}});
  return null;
}

/* ---------- Sectores y flujo de agua ---------- */
function opacidadSector(d){
  const o = Number(d && d.opacidad);
  return isFinite(o) && o > 0 ? Math.min(1, o) : 0.35;
}

function quitarClasesSector(layer){
  const el = layer.getElement && layer.getElement();
  if (el) el.classList.remove('sector-flujo', 'sector-sin-flujo');
}

/* Sector con agua: su color y opacidad, con borde animado.
   Sector sin agua: gris, borde punteado y más apagado. */
function estiloSector(layer, color, d, seleccionado){
  const activo = !!(d && d.activo);
  const op = opacidadSector(d);
  if (activo){
    layer.setStyle({color: seleccionado ? '#FFD23F' : color, weight: seleccionado ? 5 : 3.5, opacity:1,
      fillColor: color, fillOpacity: op, dashArray: null});
  } else {
    layer.setStyle({color: seleccionado ? '#FFD23F' : SIN_FLUJO.borde, weight: seleccionado ? 4 : 2, opacity:.9,
      fillColor: SIN_FLUJO.relleno, fillOpacity: Math.max(0.12, op * 0.55), dashArray:'6 6'});
  }
  const el = layer.getElement && layer.getElement();
  if (el){ el.classList.toggle('sector-flujo', activo); el.classList.toggle('sector-sin-flujo', !activo); }
  if (layer._map) layer.bringToBack();
}

function etiquetaSector(d){
  const activo = !!(d && d.activo);
  return `<b>${esc((d && d.nombre) || 'Sector sin nombre')}</b><small class="${activo ? 'con' : 'sin'}"><i></i>${activo ? 'Con agua' : 'Sin agua'}</small>`;
}

/* Etiqueta fija en el centro del sector */
function ponerEtiquetaSector(layer, d){
  const html = etiquetaSector(d);
  const t = layer.getTooltip();
  if (t && t.options.permanent){ layer.setTooltipContent(html); return; }
  if (t) layer.unbindTooltip();
  layer.bindTooltip(html, {permanent:true, direction:'center', className:'etq-sector', interactive:false});
}

/* Etiqueta que aparece al pasar el dedo o el ratón */
function ponerTooltip(layer, html){
  const t = layer.getTooltip();
  if (t && !t.options.permanent){ layer.setTooltipContent(html); return; }
  if (t) layer.unbindTooltip();
  layer.bindTooltip(html, {sticky:true, direction:'top'});
}

function desde(iso){
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const hora = d.toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'});
  if (d.toDateString() === new Date().toDateString()) return `desde las ${hora}`;
  return `desde el ${d.toLocaleDateString('es', {day:'numeric', month:'short'})}, ${hora}`;
}

window.Acu = {TIPOS, SIN_FLUJO, esc, num, cliente, traerTodo, crearMapa, capaDesdeGeom,
  opacidadSector, estiloSector, quitarClasesSector, etiquetaSector, ponerEtiquetaSector, ponerTooltip, desde};
})();
