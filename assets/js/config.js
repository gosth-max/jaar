/* =====================================================================
   Configuración compartida por todas las páginas.
   La clave pública (anon) de Supabase puede estar en GitHub: los datos
   están protegidos por las reglas de supabase.sql.
   NUNCA pongas aquí la clave "service_role" ni la "secret".
   ===================================================================== */
window.ACU_CONFIG = {
  SUPABASE_URL: 'https://dhzidoeccetdvvlvfnxd.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRoemlkb2VjY2V0ZHZ2bHZmbnhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzODQzNTUsImV4cCI6MjEwNTk2MDM1NX0.93MxyqogS8ZTDEI9aXnRFdEbwbPyIJYoVkrZ_2eHiyk',

  /* ---- Opcional: fotos satelitales de Mapbox ----
     Crea una cuenta gratis en https://account.mapbox.com, copia tu
     "Default public token" (empieza con pk.) y pégalo aquí.
     Aparecerá "Satélite (Mapbox)" en el selector de capas del mapa. */
  MAPBOX_TOKEN: '',

  /* ---- Opcional: tu propia foto aérea (por ejemplo, de un dron) ----
     Cuando tengas los mosaicos en una carpeta del repositorio, quita las
     barras // de las líneas de abajo y ajusta los valores.
     La ruta es relativa a la raíz del sitio (donde está index.html). */
  CAPA_PROPIA: null
  // CAPA_PROPIA: {
  //   nombre: 'Foto de dron 2026',
  //   url: 'assets/ortofoto/{z}/{x}/{y}.png',
  //   maxNativeZoom: 21,
  //   limites: [[8.000, -80.000], [8.010, -79.990]],   // [[sur, oeste], [norte, este]] de la zona fotografiada
  //   atribucion: 'Foto aérea del acueducto'
  // }
};

// Dirección raíz del sitio, calculada a partir de la ubicación de este archivo
window.ACU_CONFIG.RAIZ = new URL('../../', document.currentScript.src).href;
