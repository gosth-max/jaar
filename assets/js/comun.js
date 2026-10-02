/* =====================================================================
   Funciones compartidas por el mapa público (index.html)
   y la administración (assets/pages/adm/jaar.html).
   ===================================================================== */
(function(){
'use strict';

const TIPOS = {
  casa:    {nombre:'Casa',        color:'#3B6EA8', dibujo:'Polygon'},
  tuberia: {nombre:'Tubería',     color:'#00C4FF', dibujo:'Line'},
  llave:   {nombre:'Llave',       color:'#8A4FBF', dibujo:'CircleMarker'},
  sector:  {nombre:'Sector',      color:'#1E88E5', dibujo:'Polygon'},
  conector:{nombre:'Conector',    color:'#0B5C73', dibujo:'CircleMarker'},
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
  // Sesión solo en esta pestaña, con limpieza de sesiones viejas (ver sesion.js)
  if (window.AcuSesion) return window.AcuSesion.crearCliente();
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
  let actual = fuentes[elegida] ? elegida : 'Satélite (Esri)';
  fuentes[actual].addTo(map);
  map.on('baselayerchange', e => { actual = e.name; try { localStorage.setItem(BASE_KEY, e.name); } catch (err){} });

  /* Alineación de fondos: cada proveedor de fotos o calles puede estar corrido unos metros.
     Se guarda cuánto mover cada fondo (en metros, hacia el este y hacia el norte). */
  let ajustes = {};
  const aplicarAjustes = () => {
    const mpp = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
    Object.entries(fuentes).forEach(([nombre, capa]) => {
      const c = capa.getContainer && capa.getContainer(); if (!c) return;
      const a = ajustes[nombre] || {};
      c.style.marginLeft = ((Number(a.este) || 0) / mpp).toFixed(2) + 'px';
      c.style.marginTop = (-(Number(a.norte) || 0) / mpp).toFixed(2) + 'px';
    });
  };
  map.on('zoomend viewreset baselayerchange', aplicarAjustes);
  Object.values(fuentes).forEach(capa => capa.on('add', () => setTimeout(aplicarAjustes, 0)));
  map.ajustarFondos = a => { ajustes = (a && typeof a === 'object') ? JSON.parse(JSON.stringify(a)) : {}; aplicarAjustes(); };
  map.ajustesFondos = () => JSON.parse(JSON.stringify(ajustes));
  map.fondoActual = () => actual;
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

function capaDesdeGeom(g, datos){
  if (!g) return null;
  if (datos && datos.rectangulo && !Number(datos.rotacion) && g.type === 'Polygon'){   // girado: queda como polígono
    const c = g.coordinates[0] || [], lats = c.map(p => p[1]), lngs = c.map(p => p[0]);
    if (c.length >= 4) return L.rectangle([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]]);
  }
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

/* =====================================================================
   RED DE TUBERÍAS
   Cada tubería se divide en "aristas" entre sus uniones (otra tubería,
   una llave o una casa). Cada arista sabe hacia dónde corre el agua,
   así se puede recorrer la red aguas abajo desde cualquier punto.
   Flujo de una tubería: 'adelante' = del inicio del trazo al final,
   'atras' = al revés, '' = sin definir (el agua puede ir en ambos sentidos).
   ===================================================================== */
const COLOR_TUBERIA = '#00C4FF';
const METODOS_PAGO = {efectivo:'Efectivo', transferencia:'Transferencia', yappy:'Yappy', cheque:'Cheque', otro:'Otro'};
const ROJO = '#E53935';
const TOL_RED = 2.5;     // metros: dos tuberías a esta distancia se consideran unidas
const TOL_PUNTO = 3;     // metros: llaves y casas marcadas como punto
const EPS = 1e-6;

const esPuntoCapa = l => l instanceof L.CircleMarker;
const esPoligonoCapa = l => l instanceof L.Polygon;
const esLineaCapa = l => l instanceof L.Polyline && !(l instanceof L.Polygon);
const centroDe = l => esPuntoCapa(l) ? l.getLatLng() : l.getBounds().getCenter();
function anilloDeCapa(l){ let a = l.getLatLngs(); while (Array.isArray(a[0])) a = a[0]; return a; }
function partesDeCapa(l){ const ll = l.getLatLngs(); return Array.isArray(ll[0]) ? ll : [ll]; }
function proyeccion(lat0){
  const cos = Math.cos(lat0 * Math.PI / 180);
  return {a: ll => ({x: ll.lng * 111320 * cos, y: ll.lat * 110540}),
          b: p => L.latLng(p.y / 110540, p.x / (111320 * cos))};
}
function proySeg(p, a, b){
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx*dx + dy*dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t*dx, y = a.y + t*dy;
  return {t, x, y, d: Math.hypot(x - p.x, y - p.y)};
}
const lerp = (a, b, t) => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
function caja(pts, m){
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  pts.forEach(p => { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); });
  return {x1:x1 - m, y1:y1 - m, x2:x2 + m, y2:y2 + m};
}
const enCaja = (p, c) => p.x >= c.x1 && p.x <= c.x2 && p.y >= c.y1 && p.y <= c.y2;
function dentroAnillo(p, an){
  let dentro = false;
  for (let i = 0, j = an.length - 1; i < an.length; j = i++){
    const a = an[i], b = an[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) dentro = !dentro;
  }
  return dentro;
}
function cercaAnillo(p, an, tol){
  if (dentroAnillo(p, an)) return true;
  for (let i = 0; i < an.length; i++) if (proySeg(p, an[i], an[(i + 1) % an.length]).d <= tol) return true;
  return false;
}
function unirIntervalos(lista){
  const s = lista.slice().sort((a, b) => a[0] - b[0]), out = [];
  s.forEach(([a, b]) => {
    if (out.length && a <= out[out.length - 1][1] + EPS) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  });
  return out;
}

/* ---------- Conectores: T, Y, Cruz, Codo y Buje reductor ----------
   Cada conector tiene puntas (puertos) numeradas desde 1. Todas empiezan LIBRES:
   el rol de cada punta se asigna a mano en datos.puertos = ['entrada' | 'salida' | null, ...].
   · entrada: el agua llega por esa punta     · salida: el agua sale por esa punta
   · libre (null): el agua puede pasar en cualquier sentido
   datos.tamano: largo de los brazos (m). datos.rotacion: grados (0 = este). datos.espejo: lado del brazo lateral.
   Buje reductor: datos.tamanos = [pulgadas punta 1, pulgadas punta 2]; la tubería unida a cada punta toma ese diámetro. */
const BRAZO = 4;                        // tamaño de las uniones creadas antes de poder cambiarlo
const tamanoConector = d => Math.min(10, Math.max(0.3, num(d && d.tamano) || BRAZO));
const FORMAS_CONECTOR = {
  T:{nombre:'T', brazos:['Recto', 'Recto', 'Lateral'], locales:(b, l) => [[-b, 0], [b, 0], [0, l * b]], sep:1.41},
  Y:{nombre:'Y', brazos:['Tronco', 'Rama', 'Rama'], locales:b => [[-b, 0], [b * Math.cos(0.61), b * Math.sin(0.61)], [b * Math.cos(0.61), -b * Math.sin(0.61)]], sep:1.14},
  cruz:{nombre:'Cruz', brazos:['Oeste', 'Este', 'Norte', 'Sur'], locales:b => [[-b, 0], [b, 0], [0, b], [0, -b]], sep:1.41},
  codo:{nombre:'Codo', brazos:['Punta', 'Punta'], locales:(b, l) => [[-b, 0], [0, l * b]], sep:1.41},
  buje:{nombre:'Buje reductor', brazos:['Lado', 'Lado'], locales:b => [[-b, 0], [b, 0]], sep:2}
};
const formaDe = d => FORMAS_CONECTOR[d && d.forma] || FORMAS_CONECTOR.T;
/* Roles de las puntas. Las uniones creadas antes guardaban "entrada" (un índice): se convierten. */
function rolesConector(d){
  d = d || {};
  const n = formaDe(d).locales(1, 1).length;
  if (Array.isArray(d.puertos)) return Array.from({length:n}, (_, i) => d.puertos[i] === 'entrada' || d.puertos[i] === 'salida' ? d.puertos[i] : null);
  if (d.entrada === null || d.entrada === '') return Array(n).fill(null);
  const k = d.entrada === undefined ? 0 : Number(d.entrada);           // uniones antiguas: el brazo 1 era la entrada
  return Array.from({length:n}, (_, i) => i === k ? 'entrada' : 'salida');
}
function entradaConector(d){ const r = rolesConector(d), k = r.indexOf('entrada'); return k < 0 ? null : k; }
/* Distancia mínima entre dos puntas: define cuánto puede alejarse una tubería y seguir unida */
const separacionPuertos = d => tamanoConector(d) * formaDe(d).sep;
const tolPuerto = d => Math.min(1.5, separacionPuertos(d) * 0.35);
function puertosConector(centro, d){
  d = d || {};
  const th = (Number(d.rotacion) || 0) * Math.PI / 180, b = tamanoConector(d);
  const locales = formaDe(d).locales(b, d.espejo ? -1 : 1);
  const cos = Math.cos(centro.lat * Math.PI / 180);
  const pts = locales.map(([x, y]) => {
    const xr = x * Math.cos(th) - y * Math.sin(th), yr = x * Math.sin(th) + y * Math.cos(th);
    return L.latLng(centro.lat + yr / 110540, centro.lng + xr / (111320 * cos));
  });
  const roles = rolesConector(d), e = roles.indexOf('entrada');
  return {todos:pts, roles, entradaIdx:e < 0 ? null : e, entrada:e < 0 ? null : pts[e], salidas:pts.filter((_, i) => roles[i] === 'salida')};
}
/* Diámetro en pulgadas a partir de textos como "2", "1/2" o "1 1/2" */
function pulgadas(v){
  const t = String(v ?? '').trim().replace(/["”]/g, '');
  if (!t) return 0;
  const m = /^(\d+)?\s*(?:(\d+)\/(\d+))?$/.exec(t);
  if (!m) return num(t);
  return (Number(m[1]) || 0) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
}
/* Grosor con el que se dibuja una tubería según su diámetro */
function grosorTuberia(d){
  const p = pulgadas(d && d.diametro);
  if (!p) return d && d.clase === 'acometida' ? 3 : 5;
  return Math.max(2.5, Math.min(11, 2 + p * 1.6));
}
/* Dibujo: brazos gruesos; con etiquetas muestra el número de cada punta y su rol (E entrada, S salida) */
function formaConector(centro, d, opciones = {}){
  const g = L.featureGroup();
  const pr = puertosConector(centro, d), col = opciones.color || '#0B5C73';
  const comun = {interactive:!!opciones.interactivo, pmIgnore:true, snapIgnore:true, bubblingMouseEvents:true};
  const tam = Array.isArray(d && d.tamanos) ? d.tamanos : [];
  pr.todos.forEach((p, i) => {
    const grosor = d && d.forma === 'buje' && tam[i] ? Math.max(3, Math.min(12, 2 + pulgadas(tam[i]) * 1.8)) : (opciones.grosor || 6);
    L.polyline([centro, p], {...comun, color:col, weight:grosor, opacity:1, lineCap:'round'}).addTo(g);
  });
  L.circleMarker(centro, {...comun, radius:4, color:'#fff', weight:2, fillColor:col, fillOpacity:1}).addTo(g);
  if (opciones.puertos){
    pr.todos.forEach((p, i) => {
      const rol = pr.roles[i];
      L.circleMarker(p, {...comun, interactive:false, radius:4, color:col, weight:2,
        fillColor:rol === 'entrada' ? '#2F8F5B' : rol === 'salida' ? '#1D6FA3' : '#fff', fillOpacity:1}).addTo(g);
      if (opciones.etiquetas){
        const txt = (i + 1) + (rol === 'entrada' ? ' · E' : rol === 'salida' ? ' · S' : '') + (d && d.forma === 'buje' && tam[i] ? ` · ${tam[i]}"` : '');
        // la etiqueta se corre hacia afuera, en la dirección del brazo, para leerse aunque la unión sea pequeña
        const cos = Math.cos(centro.lat * Math.PI / 180), dx = (p.lng - centro.lng) * 111320 * cos, dy = (p.lat - centro.lat) * 110540;
        const l = Math.hypot(dx, dy) || 1, ox = dx / l * 20, oy = -dy / l * 20;
        L.marker(p, {interactive:false, keyboard:false, pmIgnore:true, snapIgnore:true,
          icon:L.divIcon({className:'puerto-conector' + (rol === 'entrada' ? ' entrada' : rol === 'salida' ? ' salida' : ''),
            html:`<span style="transform:translate(calc(-50% + ${ox.toFixed(1)}px), calc(-50% + ${oy.toFixed(1)}px))">${txt}</span>`, iconSize:null})}).addTo(g);
      }
    });
  }
  g.centroConector = centro;
  return g;
}
const centroConectorDe = l => l.centroConector || (esPuntoCapa(l) ? l.getLatLng() : null);

/* elementos: [{id, tipo, datos, layer}] */
function construirRed(elementos){
  const primero = elementos.find(e => e.layer);
  const P = proyeccion(primero ? centroDe(primero.layer).lat : 8.5);
  const nodos = [], celdas = new Map();
  const clave = (i, j) => i + ',' + j;
  function nodoEn(p){
    const ci = Math.floor(p.x / TOL_RED), cj = Math.floor(p.y / TOL_RED);
    let mejor = -1, md = TOL_RED;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++){
      (celdas.get(clave(ci + di, cj + dj)) || []).forEach(id => {
        const d = Math.hypot(nodos[id].x - p.x, nodos[id].y - p.y);
        if (d <= md){ md = d; mejor = id; }
      });
    }
    if (mejor >= 0) return mejor;
    const id = nodos.length;
    nodos.push({x:p.x, y:p.y});
    const k = clave(ci, cj);
    if (!celdas.has(k)) celdas.set(k, []);
    celdas.get(k).push(id);
    return id;
  }

  // 0. Puertos de los conectores: nodos propios, así una unión pequeña no mezcla sus brazos
  const conectorNodos = new Map(), puertosRed = [], nodosPuerto = new Set();
  elementos.forEach(e => {
    if (e.tipo !== 'conector' || !e.layer) return;
    const c = centroConectorDe(e.layer); if (!c) return;
    const pr = puertosConector(c, e.datos), tol = tolPuerto(e.datos);
    const ns = pr.todos.map(q => {
      const p = P.a(q), n = nodos.length;
      nodos.push({x:p.x, y:p.y}); nodosPuerto.add(n); puertosRed.push({x:p.x, y:p.y, n, tol});
      return n;
    });
    const pc = P.a(c), centro = nodos.length;
    nodos.push({x:pc.x, y:pc.y}); nodosPuerto.add(centro);
    conectorNodos.set(e.id, {puertos:ns, roles:pr.roles, centro, entrada:pr.entradaIdx});
  });
  const nodoPunta = p => {
    let mejor = null;
    puertosRed.forEach(q => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= q.tol && (!mejor || d < mejor.d)) mejor = {n:q.n, d}; });
    return mejor ? mejor.n : nodoEn(p);
  };

  // 1. Tramos de tubería
  const segs = [], tuboDir = new Map(), tuboSectores = new Map(), extremos = new Set(), tuboPuntas = new Map();
  const margen = Math.max(TOL_RED, TOL_PUNTO);
  elementos.forEach(e => {
    if (e.tipo !== 'tuberia' || !esLineaCapa(e.layer)) return;
    const d = e.datos || {};
    tuboDir.set(e.id, d.flujo === 'adelante' || d.flujo === 'atras' ? d.flujo : '');
    tuboSectores.set(e.id, Array.isArray(d.sectores) ? d.sectores : []);
    partesDeCapa(e.layer).forEach(parte => {
      const pts = parte.map(P.a);
      for (let i = 1; i < pts.length; i++){
        const extremoA = i === 1, extremoB = i === pts.length - 1;
        const s = {tubo:e.id, pa:pts[i-1], pb:pts[i], na:extremoA ? nodoPunta(pts[i-1]) : nodoEn(pts[i-1]),
          nb:extremoB ? nodoPunta(pts[i]) : nodoEn(pts[i]), cortes:[], caja:caja([pts[i-1], pts[i]], margen)};
        segs.push(s);
        if (extremoA && !nodosPuerto.has(s.na)) extremos.add(s.na);
        if (extremoB && !nodosPuerto.has(s.nb)) extremos.add(s.nb);
        // Primera y última punta de la tubería
        const pt = tuboPuntas.get(e.id) || {};
        if (extremoA && pt.ini === undefined) pt.ini = s.na;
        if (extremoB) pt.fin = s.nb;
        tuboPuntas.set(e.id, pt);
      }
    });
  });

  // 2. Llaves y casas marcadas como punto se enganchan al tramo más cercano
  function segCercano(p, tol){
    let mejor = null;
    segs.forEach(s => {
      if (!enCaja(p, s.caja)) return;
      const r = proySeg(p, s.pa, s.pb);
      if (r.d <= tol && (!mejor || r.d < mejor.d)) mejor = r;
    });
    return mejor;
  }
  const llaveNodo = new Map(), casaNodos = new Map(), sectores = [];
  elementos.forEach(e => {
    if (!e.layer) return;
    if (e.tipo === 'llave' && esPuntoCapa(e.layer)){
      // La llave va sobre la tubería: se engancha al tramo más cercano
      const r = segCercano(P.a(e.layer.getLatLng()), TOL_PUNTO);
      if (r) llaveNodo.set(e.id, nodoEn(r));
    } else if (e.tipo === 'sector' && esPoligonoCapa(e.layer)){
      sectores.push({id:e.id, anillo:anilloDeCapa(e.layer).map(P.a)});
    }
  });

  // 3. Cortar cada tramo donde lo toca otro nodo (uniones en "T", llaves…)
  segs.forEach(s => {
    nodos.forEach((n, id) => {
      if (id === s.na || id === s.nb || nodosPuerto.has(id) || !enCaja(n, s.caja)) return;
      const r = proySeg(n, s.pa, s.pb);
      if (r.d <= TOL_RED && r.t > EPS && r.t < 1 - EPS) s.cortes.push({t:r.t, n:id});
    });
  });

  // 4. Aristas y conexiones
  const aristas = [], ady = new Map(), tuboAristas = new Map();
  const unir = (n, v) => { if (!ady.has(n)) ady.set(n, []); ady.get(n).push(v); };
  segs.forEach(s => {
    const cs = [{t:0, n:s.na}, ...s.cortes.sort((a, b) => a.t - b.t), {t:1, n:s.nb}];
    const dir = tuboDir.get(s.tubo);
    for (let k = 1; k < cs.length; k++){
      const c0 = cs[k-1], c1 = cs[k];
      if (c0.n === c1.n) continue;
      const pa = lerp(s.pa, s.pb, c0.t), pb = lerp(s.pa, s.pb, c1.t);
      const e = {id:aristas.length, tubo:s.tubo, a:c0.n, b:c1.n, pa, pb, len:Math.hypot(pb.x - pa.x, pb.y - pa.y), dir};
      aristas.push(e);
      if (!tuboAristas.has(s.tubo)) tuboAristas.set(s.tubo, []);
      tuboAristas.get(s.tubo).push(e.id);
      unir(e.a, {e, otro:e.b, puede: dir !== 'atras'});
      unir(e.b, {e, otro:e.a, puede: dir !== 'adelante'});
    }
  });

  // 5. Casas: SOLO las conexiones confirmadas con «Sacar ramal». Cada tubería guarda en sus datos
  //    la casa de la que sale (casaOrigen) y la casa a la que llega (casaDestino).
  //    Una tubería o un conector que solo pasan por encima de una casa no la conectan.
  const hayCasa = new Set(elementos.filter(e => e.tipo === 'casa').map(e => e.id));
  const unirCasa = (casa, n) => { if (!hayCasa.has(casa) || n === undefined || !ady.has(n)) return;
    if (!casaNodos.has(casa)) casaNodos.set(casa, new Set()); casaNodos.get(casa).add(n); };
  elementos.forEach(e => {
    if (e.tipo !== 'tuberia') return;
    const d = e.datos || {}, pt = tuboPuntas.get(e.id); if (!pt) return;
    if (d.casaOrigen) unirCasa(d.casaOrigen, pt.ini);
    if (d.casaDestino) unirCasa(d.casaDestino, pt.fin);
  });
  const virtual = (a, b, alIr, alVolver, extra) => {
    if (a === b) return;
    const e = {id:aristas.length, tubo:null, virtual:true, a, b, pa:nodos[a], pb:nodos[b], len:Math.hypot(nodos[b].x - nodos[a].x, nodos[b].y - nodos[a].y), dir:'', ...extra};
    aristas.push(e);
    unir(a, {e, otro:b, puede:alIr});
    unir(b, {e, otro:a, puede:alVolver});
  };
  // Cada punta se une al centro: entrada → centro, centro → salida, libre ↔ centro
  conectorNodos.forEach((c, id) => c.puertos.forEach((n, i) => {
    const rol = c.roles[i];
    virtual(n, c.centro, rol !== 'salida', rol !== 'entrada', {conector:id});
  }));
  casaNodos.forEach((set, id) => { const [primero, ...resto] = [...set]; resto.forEach(n => virtual(primero, n, true, true, {casa:id})); });
  const nodoConectores = new Map();
  conectorNodos.forEach((c, id) => [...c.puertos, c.centro].forEach(n => { if (!nodoConectores.has(n)) nodoConectores.set(n, []); nodoConectores.get(n).push(id); }));

  const nodoCasas = new Map(), nodoLlaves = new Map();
  casaNodos.forEach((set, id) => set.forEach(n => { if (!nodoCasas.has(n)) nodoCasas.set(n, []); nodoCasas.get(n).push(id); }));
  llaveNodo.forEach((n, id) => { if (!nodoLlaves.has(n)) nodoLlaves.set(n, []); nodoLlaves.get(n).push(id); });

  return {
    nodos, aristas, ady, tuboAristas, tuboDir, tuboSectores, casaNodos, nodoCasas, llaveNodo, nodoLlaves, sectores, P,
    conectorNodos, nodoConectores,
    /* Punto de tubería más cercano a una posición (a menos de maxM metros) */
    puntoMasCercano(latlng, maxM, soloTubo){
      const p = P.a(latlng);
      let mejor = null;
      aristas.forEach(e => {
        if (e.virtual || (soloTubo && e.tubo !== soloTubo)) return;
        const r = proySeg(p, e.pa, e.pb);
        if (r.d <= maxM && (!mejor || r.d < mejor.d)) mejor = {arista:e, t:r.t, d:r.d, latlng:P.b(r)};
      });
      return mejor;
    },
    sectoresEn(latlng){ const p = P.a(latlng); return sectores.filter(s => dentroAnillo(p, s.anillo)).map(s => s.id); },
    sectoresQueCruza(layer){
      const ids = new Set();
      partesDeCapa(layer).forEach(parte => parte.forEach(ll => { const p = P.a(ll); sectores.forEach(s => { if (dentroAnillo(p, s.anillo)) ids.add(s.id); }); }));
      return [...ids];
    }
  };
}

function nodosDeElemento(red, id, tipo){
  if (tipo === 'tuberia') return (red.tuboAristas.get(id) || []).flatMap(i => [red.aristas[i].a, red.aristas[i].b]);
  if (tipo === 'casa') return [...(red.casaNodos.get(id) || [])];
  if (tipo === 'llave') return red.llaveNodo.has(id) ? [red.llaveNodo.get(id)] : [];
  if (tipo === 'conector'){ const c = red.conectorNodos.get(id); return c ? [...c.puertos, c.centro] : []; }
  return [];
}

/* Todo lo unido a un elemento, sin importar la dirección del agua */
function conectado(red, id, tipo){
  const tubos = new Set(), casas = new Set(), llaves = new Set(), vistos = new Set();
  const cola = nodosDeElemento(red, id, tipo);
  cola.forEach(n => vistos.add(n));
  while (cola.length){
    const n = cola.pop();
    (red.ady.get(n) || []).forEach(v => { if (!v.e.virtual) tubos.add(v.e.tubo); if (!vistos.has(v.otro)){ vistos.add(v.otro); cola.push(v.otro); } });
  }
  vistos.forEach(n => { (red.nodoCasas.get(n) || []).forEach(c => casas.add(c)); (red.nodoLlaves.get(n) || []).forEach(k => llaves.add(k)); });
  if (tipo === 'tuberia') tubos.add(id);
  if (tipo === 'casa') casas.add(id);
  if (tipo === 'llave') llaves.add(id);
  return {tubos, casas, llaves};
}

/* Camino más corto entre dos puntos de la red (A y B) */
function camino(red, A, B){
  if (A.arista.id === B.arista.id) return {cubre:[[A.arista.id, Math.min(A.t, B.t), Math.max(A.t, B.t)]], nodos:[]};
  const dist = new Map(), prev = new Map(), hechos = new Set();
  const la = A.arista;
  dist.set(la.a, A.t * la.len);        prev.set(la.a, {inicio:'a'});
  dist.set(la.b, (1 - A.t) * la.len);  prev.set(la.b, {inicio:'b'});
  const objetivo = new Set([B.arista.a, B.arista.b]);
  while (true){
    let n = -1, dn = Infinity;
    dist.forEach((d, k) => { if (!hechos.has(k) && d < dn){ dn = d; n = k; } });
    if (n < 0) break;
    hechos.add(n);
    if ([...objetivo].every(o => hechos.has(o))) break;
    (red.ady.get(n) || []).forEach(v => {
      if (v.e.id === la.id) return;
      const nd = dn + v.e.len;
      if (nd < (dist.has(v.otro) ? dist.get(v.otro) : Infinity)){ dist.set(v.otro, nd); prev.set(v.otro, {desde:n, e:v.e}); }
    });
  }
  const lb = B.arista, di = dist.has(lb.a) ? dist.get(lb.a) + B.t * lb.len : Infinity;
  const dfin = dist.has(lb.b) ? dist.get(lb.b) + (1 - B.t) * lb.len : Infinity;
  if (di === Infinity && dfin === Infinity) return null;
  const porA = di <= dfin;
  const cubre = [[lb.id, porA ? 0 : B.t, porA ? B.t : 1]], nodos = [];
  let n = porA ? lb.a : lb.b;
  while (true){
    nodos.push(n);
    const p = prev.get(n);
    if (p.inicio){ cubre.push(p.inicio === 'a' ? [la.id, 0, A.t] : [la.id, A.t, 1]); break; }
    cubre.push([p.e.id, 0, 1]);
    n = p.desde;
  }
  return {cubre, nodos};
}

/* Qué afecta una incidencia.
   inc: {ubicacion, punto_a, punto_b, propagar, sectores_enlazados, sector_id, alcance}
   origen: {id, tipo}
   Devuelve: formas (ids que se pintan completos en rojo), piezas (partes de
   tubería en rojo), puntos (marcadores del problema) y listas por tipo. */
/* Efecto de una llave cerrada según lo elegido: 'casas', 'sector' o 'ambos' */
function efectoLlave(red, llaveId, efecto){
  const r = afectacion(red, {propagar:true, ubicacion:'completo', sectores_enlazados:efecto !== 'casas'}, {id:llaveId, tipo:'llave'});
  if (efecto === 'sector') r.casas = new Set();
  if (efecto === 'casas') r.sectores = new Set();
  return r;
}
function afectacion(red, inc, origen){
  const res = {formas:new Set(), piezas:[], puntos:[], tubos:new Set(), casas:new Set(), llaves:new Set(), sectores:new Set(), conectores:new Set()};
  if (!origen) return res;
  const cob = new Map(), alcanzados = new Set();
  const cubrir = (id, t0, t1) => { if (t1 - t0 <= EPS || red.aristas[id].virtual) return; if (!cob.has(id)) cob.set(id, []); cob.get(id).push([t0, t1]); };
  const propagar = inc.propagar === true || (inc.propagar == null && inc.alcance === 'red');
  const bfs = (ini, dirigido) => {
    const cola = [...ini];
    ini.forEach(n => alcanzados.add(n));
    while (cola.length){
      const n = cola.pop();
      (red.ady.get(n) || []).forEach(v => {
        if (dirigido && !v.puede) return;
        cubrir(v.e.id, 0, 1);
        if (!alcanzados.has(v.otro)){ alcanzados.add(v.otro); cola.push(v.otro); }
      });
    }
  };
  const aguasAbajoDesde = (P, ini) => {
    const e = P.arista;
    if (e.dir !== 'atras'){ cubrir(e.id, P.t, 1); ini.push(e.b); }
    if (e.dir !== 'adelante'){ cubrir(e.id, 0, P.t); ini.push(e.a); }
  };
  const aLL = p => p && isFinite(p.lat) && isFinite(p.lng) ? L.latLng(p.lat, p.lng) : null;

  if (origen.tipo === 'llave'){
    // Llave cerrada: sin agua todo lo que está después de ella (sigue la dirección del agua)
    const n = red.llaveNodo.get(origen.id);
    if (n !== undefined) bfs([n], true);
  } else if (origen.tipo === 'sector'){
    res.sectores.add(origen.id);
  } else if (origen.tipo === 'casa'){
    res.casas.add(origen.id);
    if (propagar) bfs(nodosDeElemento(red, origen.id, 'casa'), false);
  } else if (origen.tipo === 'tuberia'){
    const ini = [];
    let ubic = inc.ubicacion || 'completo';
    const A = aLL(inc.punto_a) && red.puntoMasCercano(aLL(inc.punto_a), 30, origen.id) || (aLL(inc.punto_a) && red.puntoMasCercano(aLL(inc.punto_a), 30));
    const B = aLL(inc.punto_b) && red.puntoMasCercano(aLL(inc.punto_b), 30);
    if (ubic === 'punto' && !A) ubic = 'completo';
    if (ubic === 'tramo_ab' && !(A && B)) ubic = A ? 'punto' : 'completo';
    if (ubic === 'punto'){
      res.puntos.push(A.latlng); res.tubos.add(A.arista.tubo);
      if (propagar) aguasAbajoDesde(A, ini);
    } else if (ubic === 'tramo_ab'){
      res.puntos.push(A.latlng, B.latlng); res.tubos.add(A.arista.tubo); res.tubos.add(B.arista.tubo);
      const c = camino(red, A, B);
      if (c){ c.cubre.forEach(([id, t0, t1]) => cubrir(id, t0, t1)); c.nodos.forEach(n => { alcanzados.add(n); ini.push(n); }); }
      if (propagar) aguasAbajoDesde(A, ini);
    } else {
      // Solo se sigue desde los extremos por donde el agua sale de la tubería
      (red.tuboAristas.get(origen.id) || []).forEach(id => {
        const e = red.aristas[id];
        cubrir(id, 0, 1);
        if (e.dir !== 'atras') ini.push(e.b);
        if (e.dir !== 'adelante') ini.push(e.a);
      });
      res.tubos.add(origen.id);
    }
    if (propagar) bfs(ini, true);
  }

  // De la cobertura a piezas, tuberías completas, casas y llaves
  const cubiertas = new Map();
  cob.forEach((lista, id) => {
    const e = red.aristas[id], m = unirIntervalos(lista);
    cubiertas.set(id, m);
    res.tubos.add(e.tubo);
    m.forEach(([a, b]) => { if (a <= EPS) alcanzados.add(e.a); if (b >= 1 - EPS) alcanzados.add(e.b); });
  });
  const completa = id => { const m = cubiertas.get(id); return m && m.length === 1 && m[0][0] <= EPS && m[0][1] >= 1 - EPS; };
  res.tubos.forEach(t => {
    const ids = red.tuboAristas.get(t) || [];
    if (ids.length && ids.every(completa)){ res.formas.add(t); return; }
    ids.forEach(id => (cubiertas.get(id) || []).forEach(([a, b]) => {
      const e = red.aristas[id];
      res.piezas.push({tubo:t, latlngs:[red.P.b(lerp(e.pa, e.pb, a)), red.P.b(lerp(e.pa, e.pb, b))]});
    }));
  });
  alcanzados.forEach(n => {
    (red.nodoCasas.get(n) || []).forEach(c => res.casas.add(c));
    (red.nodoLlaves.get(n) || []).forEach(k => res.llaves.add(k));
    (red.nodoConectores.get(n) || []).forEach(k => res.conectores.add(k));
  });
  if (inc.sectores_enlazados) res.tubos.forEach(t => (red.tuboSectores.get(t) || []).forEach(s => res.sectores.add(s)));
  if (inc.sector_id) res.sectores.add(inc.sector_id);
  const existeSector = new Set(red.sectores.map(s => s.id));
  [...res.sectores].forEach(s => { if (!existeSector.has(s)) res.sectores.delete(s); });
  res.casas.forEach(c => res.formas.add(c));
  res.llaves.forEach(k => res.formas.add(k));
  res.conectores.forEach(k => res.formas.add(k));
  res.sectores.forEach(s => res.formas.add(s));
  return res;
}

function textoAfectacion(res){
  const n = (c, uno, varios) => c ? `${c} ${c === 1 ? uno : varios}` : '';
  const completos = [...res.tubos].filter(t => res.formas.has(t)).length;
  const parciales = new Set(res.piezas.map(p => p.tubo)).size;
  return [n(completos, 'tubería completa', 'tuberías completas'), n(parciales, 'tubería en parte', 'tuberías en parte'),
          n(res.casas.size, 'casa', 'casas'), n(res.llaves.size, 'llave', 'llaves'), n(res.sectores.size, 'sector', 'sectores')]
    .filter(Boolean).join(', ') || 'solo el punto marcado';
}

/* Flechas que muestran hacia dónde corre el agua */
function dibujarFlechas(map, elementos, grupo){
  grupo.clearLayers();
  elementos.forEach(e => {
    if (e.tipo !== 'tuberia' || !e.layer || !esLineaCapa(e.layer)) return;
    const f = e.datos && e.datos.flujo;
    if (f !== 'adelante' && f !== 'atras') return;
    partesDeCapa(e.layer).forEach(parte => {
      for (let i = 1; i < parte.length; i++){
        const a = parte[i-1], b = parte[i], dist = a.distanceTo(b);
        if (dist < 6) continue;
        const pa = map.project(a, 18), pb = map.project(b, 18);
        const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI + (f === 'atras' ? 180 : 0);
        const n = Math.max(1, Math.min(6, Math.floor(dist / 45)));
        for (let k = 1; k <= n; k++){
          const fr = k / (n + 1);
          L.marker([a.lat + (b.lat - a.lat) * fr, a.lng + (b.lng - a.lng) * fr], {
            icon:L.divIcon({className:'flecha-flujo', html:`<i style="transform:rotate(${ang.toFixed(1)}deg)"></i>`, iconSize:[16,16]}),
            interactive:false, keyboard:false, pmIgnore:true, snapIgnore:true
          }).addTo(grupo);
        }
      }
    });
  });
}

/* Marcador del lugar de una incidencia */
function iconoIncidencia(texto){
  return L.divIcon({className:'pin-inc', html:`<span>${esc(texto || '!')}</span>`, iconSize:[26,26], iconAnchor:[13,13]});
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

window.Acu = {METODOS_PAGO,TIPOS, SIN_FLUJO, ImagenEsri, esc, num, cliente, traerTodo, crearMapa, capaDesdeGeom, fechaHora, hace,
  COLOR_TUBERIA, ROJO, BRAZO, tamanoConector, entradaConector, rolesConector, FORMAS_CONECTOR, formaDe, pulgadas, grosorTuberia, efectoLlave, tolPuerto, puertosConector, formaConector, construirRed, conectado, afectacion, textoAfectacion, dibujarFlechas, iconoIncidencia, centroDe,
  opacidadSector, estiloSector, quitarClasesSector, etiquetaSector, ponerEtiquetaSector, ponerTooltip, desde};
})();
