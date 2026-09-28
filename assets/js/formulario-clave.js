/* =====================================================================
   Campos de contraseña (vecinos y administración)
   · data-ojo="idDelCampo"           botón para mostrar u ocultar
   · data-fuerza-de="idDelCampo"     medidor de fortaleza
   · data-coincide="idClave|idRepite" aviso de si las dos coinciden
   ===================================================================== */
(function(){
'use strict';
function fuerza(v){
  if (!v) return {n:0, txt:''};
  if (v.length < 8) return {n:1, txt:'Muy corta: usa al menos 8 caracteres'};
  let p = 1;
  if (v.length >= 12) p++;
  if (/[a-záéíóúñ]/.test(v) && /[A-ZÁÉÍÓÚÑ]/.test(v)) p++;
  if (/\d/.test(v)) p++;
  if (/[^A-Za-z0-9áéíóúñÁÉÍÓÚÑ]/.test(v)) p++;
  return p <= 2 ? {n:2, txt:'Débil: combina mayúsculas, números y símbolos, o hazla más larga'} : p === 3 ? {n:3, txt:'Aceptable'} : p === 4 ? {n:4, txt:'Buena'} : {n:5, txt:'Excelente'};
}
const OJO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
function enlazar(raiz){
  raiz.querySelectorAll('[data-ojo]').forEach(b => {
    if (b.dataset.listo) return; b.dataset.listo = '1';
    b.innerHTML = OJO;
    b.setAttribute('aria-label', 'Mostrar contraseña');
    b.addEventListener('click', () => {
      const i = document.getElementById(b.dataset.ojo), ver = i.type === 'password';
      i.type = ver ? 'text' : 'password';
      b.classList.toggle('on', ver);
      b.setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
  });
  raiz.querySelectorAll('[data-fuerza-de]').forEach(m => {
    if (m.dataset.listo) return; m.dataset.listo = '1';
    const i = document.getElementById(m.dataset.fuerzaDe);
    const pintar = () => { const f = fuerza(i.value); m.dataset.nivel = f.n; m.querySelector('span').textContent = f.txt; };
    i.addEventListener('input', pintar); pintar();
  });
  raiz.querySelectorAll('[data-coincide]').forEach(m => {
    if (m.dataset.listo) return; m.dataset.listo = '1';
    const [a, b] = m.dataset.coincide.split('|').map(id => document.getElementById(id));
    const pintar = () => {
      if (!b.value){ m.textContent = ''; m.className = 'mp-coincide'; return; }
      const ok = a.value === b.value;
      m.textContent = ok ? '✓ Las contraseñas coinciden' : '✗ Las contraseñas no coinciden';
      m.className = 'mp-coincide ' + (ok ? 'ok' : 'mal');
    };
    a.addEventListener('input', pintar); b.addEventListener('input', pintar);
  });
}
/* Deja los campos vacíos y las contraseñas ocultas (al abrir la ventana) */
function limpiar(raiz){
  raiz.querySelectorAll('[data-ojo]').forEach(b => {
    const i = document.getElementById(b.dataset.ojo); if (!i) return;
    i.value = ''; i.type = 'password'; i.dispatchEvent(new Event('input'));
    b.classList.remove('on'); b.setAttribute('aria-label', 'Mostrar contraseña');
  });
}
window.AcuClave = {fuerza, enlazar, limpiar};
enlazar(document);
})();
