// =====================================================================
//  Función "usuarios" (Supabase Edge Function)
//  Crea y elimina cuentas. Necesita la clave de servicio de Supabase,
//  que solo existe aquí dentro, nunca en las páginas.
//
//  Acciones (POST con JSON):
//    { accion: "aprobar_solicitud", id, casa_id?, volver_a }  -> administradores
//    { accion: "invitar", email, nombre, celular, numero_casa, rol, volver_a }
//          rol "vecino" -> administradores; "administrador"/"desarrollador" -> desarrollador
//    { accion: "eliminar", id }
//          vecinos -> administradores; administradores/desarrolladores -> desarrollador
// =====================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ROLES = ['vecino', 'administrador', 'desarrollador'];

type Perfil = { id: string; email: string; nombre: string | null; rol: string; estado: string };

function responder(cuerpo: Record<string, unknown>, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const texto = (v: unknown, max = 160) => String(v ?? '').trim().slice(0, max);
const correoValido = (e: string) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e);

// Envía la invitación por correo; si la cuenta ya existía, devuelve su id
async function invitarOEncontrar(admin: SupabaseClient, email: string, nombre: string, volverA: string) {
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: volverA || undefined,
    data: { nombre },
  });
  if (!error && data?.user) return { id: data.user.id, invitado: true };
  const { data: id } = await admin.rpc('usuario_id_por_email', { p_email: email });
  if (id) return { id: id as string, invitado: false };
  throw new Error(error?.message?.includes('rate limit')
    ? 'Se alcanzó el límite de correos de Supabase. Espera un rato o configura un servicio de correo propio (SMTP).'
    : 'No se pudo enviar la invitación: ' + (error?.message || 'error desconocido'));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return responder({ error: 'Método no permitido.' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ¿Quién hace la petición?
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: sesion, error: errSesion } = await admin.auth.getUser(jwt);
    if (errSesion || !sesion?.user) return responder({ error: 'Tu sesión no es válida. Vuelve a iniciar sesión.' }, 401);
    const { data: yo } = await admin.from('perfiles').select('*').eq('id', sesion.user.id).eq('estado', 'activo').maybeSingle<Perfil>();
    if (!yo || !['administrador', 'desarrollador'].includes(yo.rol)) {
      return responder({ error: 'No tienes permiso para gestionar usuarios.' }, 403);
    }
    const esDesarrollador = yo.rol === 'desarrollador';

    const cuerpo = await req.json().catch(() => ({}));
    const volverA = texto(cuerpo.volver_a, 500);

    // ---------- Aprobar una solicitud de vecino ----------
    if (cuerpo.accion === 'aprobar_solicitud') {
      const { data: sol } = await admin.from('solicitudes_registro').select('*').eq('id', texto(cuerpo.id, 60)).maybeSingle();
      if (!sol) return responder({ error: 'La solicitud ya no existe.' }, 404);
      if (sol.estado !== 'pendiente') return responder({ error: 'Esta solicitud ya fue revisada.' }, 409);

      const cuenta = await invitarOEncontrar(admin, sol.email, sol.nombre, volverA);
      const { data: existente } = await admin.from('perfiles').select('rol').eq('id', cuenta.id).maybeSingle();
      const { error: errPerfil } = await admin.from('perfiles').upsert({
        id: cuenta.id, email: sol.email.toLowerCase(), nombre: sol.nombre, celular: sol.celular,
        numero_casa: sol.numero_casa, casa_id: texto(cuerpo.casa_id, 60) || null,
        rol: existente?.rol && existente.rol !== 'vecino' ? existente.rol : 'vecino',   // nunca se baja de rol a un administrador
        estado: 'activo', creado_por: yo.id,
      });
      if (errPerfil) throw errPerfil;
      await admin.from('solicitudes_registro')
        .update({ estado: 'aprobada', revisada_en: new Date().toISOString(), revisada_por: yo.id }).eq('id', sol.id);
      return responder({
        ok: true,
        mensaje: cuenta.invitado
          ? `Solicitud aprobada. Se envió un correo a ${sol.email} para que cree su contraseña.`
          : `Solicitud aprobada. ${sol.email} ya tenía una cuenta: puede entrar con su contraseña o usar «¿Olvidaste tu contraseña?».`,
      });
    }

    // ---------- Invitar directamente (vecino, administrador o desarrollador) ----------
    if (cuerpo.accion === 'invitar') {
      const email = texto(cuerpo.email).toLowerCase();
      const rol = texto(cuerpo.rol, 20);
      if (!correoValido(email)) return responder({ error: 'Escribe un correo válido.' }, 400);
      if (!ROLES.includes(rol)) return responder({ error: 'Rol no válido.' }, 400);
      if (rol !== 'vecino' && !esDesarrollador) return responder({ error: 'Solo el desarrollador puede crear administradores.' }, 403);
      const nombre = texto(cuerpo.nombre, 120);
      if (nombre.length < 3) return responder({ error: 'Escribe el nombre.' }, 400);

      const cuenta = await invitarOEncontrar(admin, email, nombre, volverA);
      const { error } = await admin.from('perfiles').upsert({
        id: cuenta.id, email, nombre, celular: texto(cuerpo.celular, 20) || null,
        numero_casa: texto(cuerpo.numero_casa, 20) || null, casa_id: texto(cuerpo.casa_id, 60) || null,
        rol, estado: 'activo', creado_por: yo.id,
      });
      if (error) throw error;
      return responder({
        ok: true,
        mensaje: cuenta.invitado
          ? `Se envió una invitación a ${email} para que cree su contraseña.`
          : `${email} ya tenía una cuenta; ahora tiene el rol de ${rol}.`,
      });
    }

    // ---------- Eliminar una cuenta ----------
    if (cuerpo.accion === 'eliminar') {
      const id = texto(cuerpo.id, 60);
      if (id === yo.id) return responder({ error: 'No puedes eliminar tu propia cuenta.' }, 400);
      const { data: objetivo } = await admin.from('perfiles').select('*').eq('id', id).maybeSingle<Perfil>();
      if (!objetivo) return responder({ error: 'La cuenta ya no existe.' }, 404);
      if (objetivo.rol !== 'vecino' && !esDesarrollador) return responder({ error: 'Solo el desarrollador puede eliminar administradores.' }, 403);
      if (objetivo.rol === 'desarrollador') {
        const { count } = await admin.from('perfiles').select('id', { count: 'exact', head: true })
          .eq('rol', 'desarrollador').eq('estado', 'activo').neq('id', id);
        if (!count) return responder({ error: 'Debe quedar al menos un desarrollador activo.' }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      return responder({ ok: true, mensaje: `Se eliminó la cuenta de ${objetivo.email}.` });
    }

    return responder({ error: 'Acción desconocida.' }, 400);
  } catch (e) {
    console.error(e);
    return responder({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
