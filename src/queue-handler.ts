import type { Env, ResumenTriggerMessage, ResumenPersona } from './types';
import { hasResumen, upsertResumen, insertLog, trimLogs } from './db';
import { generarResumen } from './summarize';
import { sendResumenEmail } from './email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function destinatariosValidos(invitees: ResumenPersona[], recordedBy: ResumenPersona | null): ResumenPersona[] {
  const todos = [...invitees, ...(recordedBy ? [recordedBy] : [])];
  const vistos = new Set<string>();
  const validos: ResumenPersona[] = [];
  for (const p of todos) {
    const email = (p.email ?? '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || vistos.has(email)) continue;
    vistos.add(email);
    validos.push({ nombre: p.nombre, email });
  }
  return validos;
}

export async function handleResumenMessage(msg: ResumenTriggerMessage, env: Env): Promise<void> {
  const { folder, recording_id, r2_key, title, created_at, share_url, invitees, recorded_by } = msg;

  if (await hasResumen(env.DB, recording_id)) {
    await insertLog(env.DB, 'INFO', `— Ya procesado, se omite: ${title || recording_id}`, recording_id);
    return;
  }

  await upsertResumen(env.DB, {
    recording_id, folder, title, created_at, share_url,
    status: 'pendiente',
  });

  // 1) Obtener transcripción desde R2 (compartido con fanthom-superleads)
  const obj = await env.R2.get(r2_key);
  if (!obj) {
    // El archivo puede tardar unos segundos en aparecer en R2; dejamos que la cola reintente.
    throw new Error(`Transcripción no encontrada en R2: ${r2_key}`);
  }
  const contenido = await obj.text();

  // 2) Generar el resumen con Workers AI — si falla, dejamos que la cola reintente (aún no se envió nada)
  let resumenTexto: string;
  try {
    resumenTexto = await generarResumen(env, { title, created_at, folder }, contenido);
  } catch (e: any) {
    await insertLog(env.DB, 'ERROR', `Fallo generando resumen [${title}]: ${e?.message ?? e}`, recording_id);
    throw e;
  }

  await upsertResumen(env.DB, { recording_id, resumen_texto: resumenTexto });
  await insertLog(env.DB, 'INFO', `✓ Resumen generado: ${title || recording_id}`, recording_id);

  // 3) Determinar destinatarios
  const destinatarios = destinatariosValidos(invitees, recorded_by);
  if (destinatarios.length === 0) {
    await upsertResumen(env.DB, {
      recording_id, status: 'sin_destinatarios',
      procesado_en: new Date().toISOString(),
    });
    await insertLog(env.DB, 'WARNING', `Sin destinatarios con email válido — no se envía correo: ${title}`, recording_id);
    await trimLogs(env.DB);
    return;
  }

  // 4) Enviar un correo personalizado a cada destinatario.
  // A partir de aquí NO relanzamos errores: un fallo parcial no debe reintentar
  // el mensaje completo (duplicaría correos ya enviados con éxito).
  let enviados = 0;
  const errores: string[] = [];
  for (const persona of destinatarios) {
    const resultado = await sendResumenEmail(env, {
      to: persona.email!,
      nombreDestino: persona.nombre ?? '',
      title,
      shareUrl: share_url,
      resumenTexto,
    });
    if (resultado.ok) {
      enviados++;
      await insertLog(env.DB, 'INFO', `  ✉ Enviado a ${persona.email} (id: ${resultado.id})`, recording_id);
    } else {
      errores.push(`${persona.email}: ${resultado.error}`);
      await insertLog(env.DB, 'ERROR', `  ✗ Falló envío a ${persona.email}: ${resultado.error}`, recording_id);
    }
  }

  await upsertResumen(env.DB, {
    recording_id,
    destinatarios: JSON.stringify(destinatarios.map(p => p.email)),
    status: enviados > 0 ? 'enviado' : 'error',
    error: errores.length ? errores.join(' | ') : null,
    procesado_en: new Date().toISOString(),
  });

  await insertLog(
    env.DB, 'INFO',
    `Resumen [${title}]: ${enviados}/${destinatarios.length} correos enviados`,
    recording_id,
  );
  await trimLogs(env.DB);
}
