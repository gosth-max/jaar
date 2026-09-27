/* =====================================================================
   Aviso de cookies y almacenamiento local (compartido por las páginas públicas)
   Uso: <script src="assets/js/sitio.js" data-privacidad="privacidad.html"></script>
   ===================================================================== */
(function(){
  'use strict';
  var CLAVE = 'acu-aviso-cookies-v1';
  var script = document.currentScript;
  var enlace = (script && script.dataset.privacidad) || 'privacidad.html';
  try { if (localStorage.getItem(CLAVE)) return; } catch (e){ return; }

  var css = '.aviso-cookies{position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:6000;max-width:640px;margin:0 auto;' +
    'background:#15323B;color:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 14px 40px rgba(0,0,0,.35);display:flex;gap:14px;align-items:center;flex-wrap:wrap;' +
    'font:14px/1.45 "Inter","Atkinson Hyperlegible",system-ui,sans-serif}' +
    '.aviso-cookies p{margin:0;flex:1 1 280px}.aviso-cookies a{color:#7EC3EA}' +
    '.aviso-cookies button{background:#7EC3EA;color:#15323B;border:0;border-radius:9px;padding:9px 16px;font:700 14px system-ui,sans-serif;cursor:pointer}';
  var estilo = document.createElement('style'); estilo.textContent = css; document.head.appendChild(estilo);

  var caja = document.createElement('div');
  caja.className = 'aviso-cookies';
  caja.setAttribute('role', 'region');
  caja.setAttribute('aria-label', 'Aviso de cookies');
  caja.innerHTML = '<p>Este sitio no usa cookies de publicidad ni de seguimiento. Solo guarda en tu navegador lo necesario para funcionar, como tu sesión si inicias una. ' +
    '<a href="' + enlace + '#cookies">Más información</a>.</p><button type="button">Entendido</button>';
  caja.querySelector('button').addEventListener('click', function(){
    try { localStorage.setItem(CLAVE, new Date().toISOString()); } catch (e){}
    caja.remove();
  });
  function poner(){ document.body.appendChild(caja); }
  if (document.body) poner(); else document.addEventListener('DOMContentLoaded', poner);
})();
