/* =====================================================================
   Sesiones seguras (página pública, administración y acceso)
   · La sesión se guarda en el almacenamiento DE LA PESTAÑA (sessionStorage):
     el navegador la borra solo al cerrar la pestaña o el navegador.
   · Se cierra sola tras un tiempo sin actividad, con aviso un minuto antes.
   · Al cerrar sesión se borra todo rastro de la sesión en el navegador.
   ===================================================================== */
(function(){
'use strict';
const MINUTOS_INACTIVIDAD = 30;          // tiempo sin usar la página antes de cerrar la sesión
const SEGUNDOS_AVISO = 60;               // aviso previo
const CLAVE_ACTIVIDAD = 'acu-ultima-actividad';

function almacenPestana(){
  try { sessionStorage.setItem('__prueba', '1'); sessionStorage.removeItem('__prueba'); return window.sessionStorage; }
  catch (e){ return undefined; }        // sin sessionStorage: Supabase usa su almacén por defecto
}
/* Borra sesiones guardadas a la antigua (almacenamiento permanente) y los datos de sesión de la pestaña */
function limpiar(){
  try { Object.keys(localStorage).filter(k => /^sb-.+-auth-token/.test(k) || k === 'supabase.auth.token').forEach(k => localStorage.removeItem(k)); } catch (e){}
  try { sessionStorage.clear(); } catch (e){}
}
function limpiarViejas(){
  try { Object.keys(localStorage).filter(k => /^sb-.+-auth-token/.test(k) || k === 'supabase.auth.token').forEach(k => localStorage.removeItem(k)); } catch (e){}
}
function crearCliente(){
  const c = window.ACU_CONFIG || {};
  if (!window.supabase || !c.SUPABASE_URL) throw new Error('Falta la configuración de Supabase.');
  limpiarViejas();
  return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_KEY, {
    auth:{storage:almacenPestana(), persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}
  });
}
/* Cierra la sesión solo en este navegador (las de otros dispositivos siguen abiertas) y limpia todo */
async function cerrar(sb, destino, motivo){
  try { if (sb) await sb.auth.signOut({scope:'local'}); } catch (e){}
  limpiar();
  if (destino) location.replace(destino + (motivo ? (destino.includes('?') ? '&' : '?') + 'motivo=' + encodeURIComponent(motivo) : ''));
}
/* Cierre automático por inactividad */
function vigilarInactividad(sb, opciones = {}){
  const minutos = opciones.minutos || MINUTOS_INACTIVIDAD, destino = opciones.destino;
  const limite = minutos * 60000, avisoMs = SEGUNDOS_AVISO * 1000;
  let caja = null, cuenta = null;
  const marcar = () => { try { sessionStorage.setItem(CLAVE_ACTIVIDAD, String(Date.now())); } catch (e){} };
  const ultima = () => { try { return Number(sessionStorage.getItem(CLAVE_ACTIVIDAD)) || Date.now(); } catch (e){ return Date.now(); } };
  let ultimoMarcado = 0;
  const actividad = () => {
    if (caja) return;                                  // con el aviso visible, solo cuenta el botón
    const ahora = Date.now();
    if (ahora - ultimoMarcado > 15000){ ultimoMarcado = ahora; marcar(); }
  };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(ev => window.addEventListener(ev, actividad, {passive:true, capture:true}));
  marcar();
  const quitarAviso = () => { if (caja){ caja.remove(); caja = null; } clearInterval(cuenta); cuenta = null; };
  const mostrarAviso = () => {
    if (caja) return;
    caja = document.createElement('div');
    caja.setAttribute('role', 'alertdialog');
    caja.setAttribute('aria-live', 'assertive');
    caja.style.cssText = 'position:fixed;inset:0;z-index:9000;display:grid;place-items:center;background:rgba(21,50,59,.55);font-family:"Inter","Atkinson Hyperlegible",system-ui,sans-serif';
    caja.innerHTML = `<div style="background:#fff;color:#15323B;border-radius:16px;padding:22px 24px;max-width:380px;width:90vw;box-shadow:0 20px 50px rgba(0,0,0,.35);text-align:center">
        <div style="font-size:34px" aria-hidden="true">⏳</div>
        <h2 style="margin:6px 0;font-size:19px">¿Sigues ahí?</h2>
        <p style="margin:0 0 14px;color:#5B7078">Por seguridad, tu sesión se cerrará en <b data-seg>${SEGUNDOS_AVISO}</b> segundos por inactividad.</p>
        <button type="button" data-seguir style="background:#1D6FA3;color:#fff;border:0;border-radius:10px;padding:11px 18px;font:700 15px system-ui,sans-serif;cursor:pointer">Seguir conectado</button>
      </div>`;
    document.body.appendChild(caja);
    caja.querySelector('[data-seguir]').addEventListener('click', () => { marcar(); ultimoMarcado = Date.now(); quitarAviso(); });
    caja.querySelector('[data-seguir]').focus();
    cuenta = setInterval(() => {
      const falta = Math.max(0, Math.ceil((ultima() + limite - Date.now()) / 1000));
      const s = caja && caja.querySelector('[data-seg]'); if (s) s.textContent = falta;
    }, 1000);
  };
  const revisar = () => {
    const quieto = Date.now() - ultima();
    if (quieto >= limite){ quitarAviso(); cerrar(sb, destino, 'inactividad'); return; }
    if (quieto >= limite - avisoMs) mostrarAviso(); else quitarAviso();
  };
  setInterval(revisar, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) revisar(); });
}
window.AcuSesion = {crearCliente, cerrar, limpiar, vigilarInactividad, MINUTOS_INACTIVIDAD};
})();
