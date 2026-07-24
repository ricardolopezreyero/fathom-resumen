// RLR
import type { Env, ResumenTriggerMessage, ResumenPersona } from './types';
import { hasResumen, upsertResumen, insertLog, trimLogs } from './db';
import { generarResumen } from './summarize';
import { sendResumenEmail, enviarAlertaAdmin, ADMIN_EMAIL } from './email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_CONTENIDO_CHARS = 120;

function limpiarEmail(email: string | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

/** Quién originó la transcripción: el colaborador registrado siempre gana
 *  sobre recorded_by (dato de Fathom, menos confiable), que a su vez gana
 *  sobre el admin por defecto. Este origen es siempre el "De"/Reply-To. */
function resolverOrigen(msg: ResumenTriggerMessage): { nombre: string; email: string } {
  const colabEmail = limpiarEmail(msg.colaborador_email ?? undefined);
  if (colabEmail) return { nombre: msg.colaborador_nombre || msg.recorded_by?.nombre || 'SuperLeads', email: colabEmail };

  const grabadorEmail = limpiarEmail(msg.recorded_by?.email);
  if (grabadorEmail) return { nombre: msg.recorded_by?.nombre || msg.colaborador_nombre || 'SuperLeads', email: grabadorEmail };

  return { nombre: 'SuperLeads', email: ADMIN_EMAIL };
}

function destinatariosValidos(invitees: ResumenPersona[], excluirEmail: string): ResumenPersona[] {
  const vistos = new Set<string>([excluirEmail]);
  const validos: ResumenPersona[] = [];
  for (const p of invitees) {
    const email = limpiarEmail(p.email);
    if (!email || vistos.has(email)) continue;
    vistos.add(email);
    validos.push({ nombre: p.nombre, email });
  }
  return validos;
}

/** Evita generar/enviar un "resumen" vacío para reuniones sin transcripción real
 *  (sala personal sin grabación útil, llamada colgada de inmediato, etc). */
function contenidoUtil(contenido: string): boolean {
  const marcador = '════════════════════════════════════════════════════════════';
  const idx = contenido.lastIndexOf(marcador);
  const cuerpo = idx >= 0 ? contenido.slice(idx + marcador.length) : contenido;
  const texto = cuerpo.trim();
  if (!texto) return false;
  if (texto.includes('[Sin transcripción disponible]') || texto.includes('[Transcripción vacía]')) return false;
  return texto.length >= MIN_CONTENIDO_CHARS;
}

export async function handleResumenMessage(
  msg: ResumenTriggerMessage,
  env: Env,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { folder, recording_id, r2_key, title, created_at, share_url, invitees } = msg;

  if (!opts.force && await hasResumen(env.DB, recording_id)) {
    await insertLog(env.DB, 'INFO', `— Ya procesado, se omite: ${title || recording_id}`, recording_id);
    return;
  }

  const origen = resolverOrigen(msg);

  await upsertResumen(env.DB, {
    recording_id, folder, title, created_at, share_url,
    origen_nombre: origen.nombre, origen_email: origen.email,
    status: 'pendiente',
  });

  // 1) Obtener transcripción desde R2 (compartido con fanthom-superleads)
  const obj = await env.R2.get(r2_key);
  if (!obj) {
    // El archivo puede tardar unos segundos en aparecer en R2; dejamos que la cola reintente.
    throw new Error(`Transcripción no encontrada en R2: ${r2_key}`);
  }
  const contenido = await obj.text();

  if (!contenidoUtil(contenido)) {
    await upsertResumen(env.DB, {
      recording_id, status: 'sin_contenido',
      procesado_en: new Date().toISOString(),
    });
    await insertLog(env.DB, 'INFO', `— Sin transcripción real (reunión muy corta o sin grabación útil): ${title}`, recording_id);
    await trimLogs(env.DB);
    return;
  }

  // 2) Determinar destinatarios ANTES de gastar una llamada a Workers AI —
  // si no hay a quién escribirle no tiene caso generar el resumen.
  const destinatarios = destinatariosValidos(invitees, origen.email);
  if (destinatarios.length === 0) {
    await upsertResumen(env.DB, {
      recording_id, status: 'sin_destinatarios',
      procesado_en: new Date().toISOString(),
    });
    await insertLog(env.DB, 'WARNING', `Sin destinatarios con email válido (o solo el propio origen) — no se envía correo: ${title}`, recording_id);
    await trimLogs(env.DB);
    return;
  }

  // 3) Generar el resumen con Workers AI — si falla, dejamos que la cola reintente (aún no se envió nada)
  let resumenTexto: string;
  try {
    resumenTexto = await generarResumen(env, { title, created_at, origenNombre: origen.nombre }, contenido);
  } catch (e: any) {
    await insertLog(env.DB, 'ERROR', `Fallo generando resumen [${title}]: ${e?.message ?? e}`, recording_id);
    throw e;
  }

  await upsertResumen(env.DB, { recording_id, resumen_texto: resumenTexto });
  await insertLog(env.DB, 'INFO', `✓ Resumen generado: ${title || recording_id}`, recording_id);

  // 4) Enviar un correo personalizado a cada destinatario.
  // A partir de aquí NO relanzamos errores: un fallo parcial no debe reintentar
  // el mensaje completo (duplicaría correos ya enviados con éxito).
  let enviados = 0;
  const errores: string[] = [];
  const resendIds: Record<string, string> = {};
  for (const persona of destinatarios) {
    const resultado = await sendResumenEmail(env, {
      to: persona.email!,
      nombreDestino: persona.nombre ?? '',
      origenNombre: origen.nombre,
      origenEmail: origen.email,
      title,
      shareUrl: share_url,
      resumenTexto,
    });
    if (resultado.ok) {
      enviados++;
      if (resultado.id) resendIds[persona.email!] = resultado.id;
      await insertLog(env.DB, 'INFO', `  ✉ Enviado a ${persona.email} desde ${origen.email} (id: ${resultado.id})`, recording_id);
    } else {
      errores.push(`${persona.email}: ${resultado.error}`);
      await insertLog(env.DB, 'ERROR', `  ✗ Falló envío a ${persona.email}: ${resultado.error}`, recording_id);
    }
  }

  const status = enviados > 0 ? 'enviado' : 'error';
  await upsertResumen(env.DB, {
    recording_id,
    destinatarios: JSON.stringify(destinatarios.map(p => p.email)),
    resend_id: JSON.stringify(resendIds),
    status,
    error: errores.length ? errores.join(' | ') : null,
    procesado_en: new Date().toISOString(),
  });

  await insertLog(
    env.DB, 'INFO',
    `Resumen [${title}]: ${enviados}/${destinatarios.length} correos enviados`,
    recording_id,
  );

  if (status === 'error') {
    // Nadie recibió el correo pese a haber destinatarios válidos — esto sí merece
    // una alerta activa, no solo quedar en el log esperando a que alguien lo revise.
    await enviarAlertaAdmin(env, { folder, recordingId: recording_id, title, errores }).catch(() => {});
  }

  await trimLogs(env.DB);
}
