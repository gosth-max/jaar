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

/* ---------- Fotos satelitales de Esri sin zonas grises ----------
   Esri no tiene fotos de alto detalle en todas partes. Donde no existen,
   devuelve una imagen gris. Esta capa pregunta primero a Esri (servicio
   "tilemap") qué fotos existen y, si falta una, usa la del nivel anterior
   ampliada. Si Esri no responde, se comporta como una capa normal. */
const NIVEL_SEGURO = 13;   // hasta este zoom siempre hay foto
const ImagenEsri = L.GridLayer.extend({
  initialize(base, opciones){
    this._base = base.replace(/\/$/, '');
    this._bloques = new Map();
    L.GridLayer.prototype.initialize.call(this, opciones);
  },
  _bloque(z, x, y){
    const T = 32, left = Math.floor(x / T) * T, top = Math.floor(y / T) * T;
    const k = `${z}/${top}/${left}`;
    if (!this._bloques.has(k)){
      this._bloques.set(k,
        fetch(`${this._base}/tilemap/${z}/${top}/${left}/${T}/${T}?f=json`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
          .then(j => (j && Array.isArray(j.data) && j.location) ? j : null));
    }
    return this._bloques.get(k);
  },
  async _existe(z, x, y){
    const j = await this._bloque(z, x, y);
    if (!j) return true;                         // sin información: se pide la foto igual
    const loc = j.location, cx = x - loc.left, cy = y - loc.top;
    if (cx < 0 || cy < 0 || cx >= loc.width || cy >= loc.height) return true;
    return j.data[cy * loc.width + cx] !== 0;
  },
  async _nivelDisponible(c){
    for (let z = c.z; z > NIVEL_SEGURO; z--){
      const f = 2 ** (c.z - z);
      const x = Math.floor(c.x / f), y = Math.floor(c.y / f);
      if (await this._existe(z, x, y)) return {z, x, y};
    }
    const f = 2 ** Math.max(0, c.z - NIVEL_SEGURO);
    return {z:Math.min(c.z, NIVEL_SEGURO), x:Math.floor(c.x / f), y:Math.floor(c.y / f)};
  },
  createTile(coords, done){
    const tile = document.createElement('div');
    const size = this.getTileSize();
    this._nivelDisponible(coords).then(n => {
      const esc = 2 ** (coords.z - n.z);
      const img = document.createElement('img');
      img.alt = ''; img.setAttribute('role', 'presentation'); img.decoding = 'async';
      img.style.cssText = `position:absolute;max-width:none;width:${size.x * esc}px;height:${size.y * esc}px;` +
        `left:${-(coords.x - n.x * esc) * size.x}px;top:${-(coords.y - n.y * esc) * size.y}px`;
      img.onload = () => done(null, tile);
      img.onerror = () => done(new Error('foto no disponible'), tile);
      img.src = `${this._base}/tile/${n.z}/${n.y}/${n.x}`;
      tile.appendChild(img);
    });
    return tile;
  }
});

/* ---------- Mapa base ---------- */
const BASE_KEY = 'acueducto-base';
function crearMapa(id, opciones = {}){
  const cfg = window.ACU_CONFIG || {};
  const map = L.map(id, {zoomControl:false, maxZoom:21}).setView([8.6, -80.1], 7);
  L.control.zoom({position:'topleft'}).addTo(map);

  const fuentes = {};
  fuentes['Satélite (Esri)'] = new ImagenEsri('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {maxZoom:21, maxNativeZoom:19, attribution:'Imágenes &copy; Esri, Maxar, Earthstar Geographics'});
  fuentes['Satélite nítido (Esri Clarity)'] = new ImagenEsri('https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer',
    {maxZoom:21, maxNativeZoom:19, attribution:'Imágenes &copy; Esri, Maxar, Earthstar Geographics'});
  if (cfg.MAPBOX_TOKEN){
    fuentes['Satélite (Mapbox)'] = L.tileLayer(
      'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=' + encodeURIComponent(cfg.MAPBOX_TOKEN),
      {maxZoom:21, maxNativeZoom:19, tileSize:256,
       attribution:'&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> &copy; Maxar'});
  }
  fuentes['Calles'] = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {maxZoom:21, maxNativeZoom:19, attribution:'&copy; colaboradores de OpenStreetMap'});

  // Foto propia (por ejemplo, de un dron) encima del satélite
  const capasExtra = {};
  const propia = cfg.CAPA_PROPIA;
  if (propia && propia.url){
    const url = /^https?:\/\//.test(propia.url) ? propia.url : (cfg.RAIZ || '') + propia.url;
    const opc = {maxZoom:21, maxNativeZoom:propia.maxNativeZoom || 21, attribution:propia.atribucion || '', zIndex:5,
      errorTileUrl:'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='};
    if (propia.limites) opc.bounds = L.latLngBounds(propia.limites);
    if (propia.tms) opc.tms = true;
    const capaPropia = L.tileLayer(url, opc).addTo(map);
    capasExtra[propia.nombre || 'Foto propia'] = capaPropia;
  }

  let elegida = null;
  try { elegida = localStorage.getItem(BASE_KEY); } catch (e){}
  (fuentes[elegida] || fuentes['Satélite (Esri)']).addTo(map);
  map.on('baselayerchange', e => { try { localStorage.setItem(BASE_KEY, e.name); } catch (err){} });
  L.control.layers(fuentes, capasExtra, {position:'bottomleft'}).addTo(map);

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

function etiquetaSector(d, incidencia){
  const activo = !!(d && d.activo);
  return `<b>${esc((d && d.nombre) || 'Sector sin nombre')}</b><small class="${activo ? 'con' : 'sin'}"><i></i>${activo ? 'Con agua' : 'Sin agua'}</small>` +
    (incidencia ? `<small class="inc">⚠ ${esc(incidencia)}</small>` : '');
}

/* Etiqueta fija en el centro del sector */
function ponerEtiquetaSector(layer, d, incidencia){
  const html = etiquetaSector(d, incidencia);
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

function fechaHora(iso){
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('es', {day:'numeric', month:'short', year:'numeric'}) + ', ' + d.toLocaleTimeString('es', {hour:'numeric', minute:'2-digit'});
}
function hace(iso){
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const dias = Math.round(h / 24);
  return dias === 1 ? 'hace 1 día' : `hace ${dias} días`;
}

window.Acu = {TIPOS, SIN_FLUJO, ImagenEsri, esc, num, cliente, traerTodo, crearMapa, capaDesdeGeom, fechaHora, hace,
  opacidadSector, estiloSector, quitarClasesSector, etiquetaSector, ponerEtiquetaSector, ponerTooltip, desde};
})();
