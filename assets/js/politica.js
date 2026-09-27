/* =====================================================================
   Política de privacidad: texto base y formato sencillo
   ## Título · ### Subtítulo · - lista · **negrita** · [texto](enlace)
   Marcadores: {acueducto} {correo} {whatsapp}
   ===================================================================== */
(function(){
'use strict';
const TEXTO_BASE = `## Quién es responsable de tus datos
El responsable del tratamiento de los datos de este sitio es la junta administradora de **{acueducto}**, que lo usa para gestionar el servicio de agua de la comunidad.

Esta política se rige por la legislación de la República de Panamá sobre protección de datos personales (Ley 81 de 2019 y su reglamentación).

## Qué datos usamos
- **Quien solicita una cuenta:** nombre del representante legal de la casa, número de casa, celular y correo electrónico.
- **Vecinos con cuenta:** los datos anteriores, las casas vinculadas, su estado de cuenta y los reportes que envían (tipo, descripción y, si la marcan, la ubicación del problema).
- **Administradores:** nombre, cargo, celular, número de casa y correo, y el registro de su trabajo en el sistema.
- **Casas del acueducto:** representante, teléfono, núcleos familiares, cuotas, pagos, arreglos de pago y avisos de corte. Estos datos son internos.
- **Datos técnicos:** para frenar abusos, al enviar una solicitud se guarda una huella anónima de la conexión (no la dirección IP).

No pedimos datos sensibles (salud, religión, opiniones políticas, etc.) ni datos de menores de edad.

## Para qué los usamos
- Verificar que quien pide una cuenta es el representante legal de la casa.
- Crear y administrar tu cuenta.
- Llevar el estado de cuenta de cada casa: cuotas, pagos, arreglos de pago y avisos de corte.
- Recibir, atender y responder los reportes sobre el servicio.
- Comunicarnos contigo sobre el servicio, por ejemplo cortes programados o avisos de corte.
- Proteger el sitio contra spam y abusos.

No vendemos tus datos ni los usamos para publicidad.

## Por qué podemos usarlos
Usamos tus datos con tu **consentimiento**, que das al enviar la solicitud de cuenta, y porque son necesarios para **prestar y administrar el servicio de agua** del que eres usuario. Puedes retirar tu consentimiento cuando quieras; en ese caso eliminaremos tu cuenta.

## Quién puede ver la información
El sitio solo se puede ver con una cuenta. Los vecinos ven el mapa de la red, el estado de los sectores, las incidencias publicadas y el estado de cuenta de **sus propias casas**. Solo los administradores ven los datos de las demás casas. Nunca se muestran a otros vecinos nombres, teléfonos, correos, pagos ni deudas ajenas.

## Con quién se comparten
Para que el sitio funcione usamos estos proveedores, que tratan los datos por nuestra cuenta:
- **Supabase:** guarda la base de datos y gestiona las cuentas. Sus servidores pueden estar fuera de Panamá.
- **GitHub Pages:** publica las páginas del sitio.
- **Esri y OpenStreetMap:** proveen las imágenes del mapa; reciben la dirección de conexión de tu dispositivo al cargar el mapa.
- **WhatsApp:** solo si decides escribirnos por ese medio, con sus propias condiciones.

Solo entregaremos datos a una autoridad cuando la ley lo exija.

## Cuánto tiempo se guardan
- Solicitudes rechazadas: hasta 6 meses, para evitar abusos.
- Cuentas de vecinos y administradores: mientras la cuenta exista. Si se elimina, se borran el correo, el celular y el acceso; los reportes se conservan sin tu nombre.
- Estado de cuenta, pagos y avisos de corte: mientras seas usuario del servicio y el tiempo que exijan las obligaciones contables de la junta.
- Registro de trabajo de la administración: el nombre y el cargo de quien registró, resolvió o atendió cada incidencia se conservan como constancia de la gestión del servicio.

## Tus derechos
Puedes pedir en cualquier momento el **acceso** a tus datos, su **rectificación**, su **cancelación**, la **oposición** a algún uso y la **portabilidad** de tus datos. Escríbenos por los medios de la sección de contacto. Si no quedas conforme, puedes acudir a la Autoridad Nacional de Transparencia y Acceso a la Información (ANTAI).

## Seguridad
La conexión al sitio está cifrada. Cada persona solo puede ver lo que le corresponde, las cuentas se crean únicamente cuando un administrador aprueba la solicitud, y el sitio limita las solicitudes y reportes para evitar abusos.

## Aviso de cookies
Este sitio **no usa cookies de publicidad, de análisis ni de seguimiento**. Solo guarda en tu navegador lo imprescindible para funcionar:
- **Sesión de tu cuenta:** se guarda solo mientras la pestaña está abierta. Se borra al cerrar la pestaña o el navegador, al cerrar sesión y, por seguridad, después de 30 minutos sin actividad.
- **Aviso de cookies visto:** para no volver a mostrarte el aviso.
- **Preferencias del mapa:** el tipo de mapa y la zona que estabas viendo.
- **Tiempo de espera:** cuándo puedes enviar otra solicitud o reporte.

Como son necesarios para el funcionamiento, no requieren tu consentimiento, pero puedes borrarlos desde la configuración de tu navegador.

## Cambios en esta política
Si cambiamos esta política, actualizaremos la fecha que aparece al inicio y, si el cambio es importante, lo avisaremos en el sitio.

## Contacto
Para cualquier consulta sobre tus datos o para ejercer tus derechos escríbenos a {correo}{whatsapp}.`;

const escHtml = v => String(v ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const slug = t => /cookie/i.test(t) ? 'cookies'
  : t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'seccion';

/* Convierte el texto con formato sencillo a HTML seguro */
function render(md, datos = {}){
  const correo = datos.correo ? `[${datos.correo}](mailto:${datos.correo})` : 'los medios de contacto del acueducto';
  const wa = datos.whatsapp ? ` o por [WhatsApp](https://wa.me/${String(datos.whatsapp).replace(/\D/g, '')})` : '';
  const texto = String(md || '').replace(/\{acueducto\}/g, datos.acueducto || 'el acueducto').replace(/\{correo\}/g, correo).replace(/\{whatsapp\}/g, wa);
  const enLinea = t => escHtml(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|#)[^)\s]+)\)/g, (m, a, u) => `<a href="${u}"${u.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${a}</a>`);
  const secciones = [], partes = [];
  let lista = null, parrafo = [], abierta = false;
  const cerrarParrafo = () => { if (parrafo.length){ partes.push(`<p>${enLinea(parrafo.join(' '))}</p>`); parrafo = []; } };
  const cerrarLista = () => { if (lista){ partes.push(`<ul>${lista.map(i => `<li>${enLinea(i)}</li>`).join('')}</ul>`); lista = null; } };
  texto.split(/\r?\n/).forEach(linea => {
    const l = linea.trim();
    let m;
    if ((m = /^##\s+(.+)$/.exec(l)) && !l.startsWith('###')){
      cerrarParrafo(); cerrarLista();
      if (abierta) partes.push('</section>');
      let id = slug(m[1]); while (secciones.some(s => s.id === id)) id += '-2';
      secciones.push({id, titulo:m[1]});
      partes.push(`<section id="${id}"><h2>${secciones.length}. ${enLinea(m[1])}</h2>`); abierta = true;
    } else if ((m = /^###\s+(.+)$/.exec(l))){ cerrarParrafo(); cerrarLista(); partes.push(`<h3>${enLinea(m[1])}</h3>`); }
    else if ((m = /^[-*]\s+(.+)$/.exec(l))){ cerrarParrafo(); (lista = lista || []).push(m[1]); }
    else if (!l){ cerrarParrafo(); cerrarLista(); }
    else { cerrarLista(); parrafo.push(l); }
  });
  cerrarParrafo(); cerrarLista();
  if (abierta) partes.push('</section>');
  return {html:partes.join('\n'), secciones};
}
window.AcuPolitica = {TEXTO_BASE, render};
})();
