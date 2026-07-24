// RLR
import type { Env, ResumenTriggerMessage, ResumenPersona } from './types';
import type { Idioma } from './summarize';
import { hasResumen, upsertResumen, insertLog, trimLogs, estaBloqueado, registrarEnvio } from './db';
import { generarResumen } from './summarize';
import { sendResumenEmail, enviarAlertaAdmin, enviarBorradorParaRevision, ADMIN_EMAIL } from './email';

export const MAX_INTENTOS_COLA = 3; // debe coincidir con max_retries del consumer en wrangler.toml
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

async function destinatariosValidos(db: D1Database, invitees: ResumenPersona[], excluirEmail: string): Promise<ResumenPersona[]> {
  const vistos = new Set<string>([excluirEmail]);
  const validos: ResumenPersona[] = [];
  for (const p of invitees) {
    const email = limpiarEmail(p.email);
    if (!email || vistos.has(email)) continue;
    vistos.add(email);
    if (await estaBloqueado(db, email)) continue; // rebotó o se quejó antes — no insistir
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

function extraerDuracion(contenido: string, idioma: Idioma): string | undefined {
  const m = contenido.match(/Duración:\s*(.+)/);
  let val = m?.[1]?.trim();
  if (!val || val === '—') return undefined;
  // El header en R2 siempre queda en español ("X min Y seg") — lo adaptamos
  // para que no desentone en un correo redactado en inglés.
  if (idioma === 'en') val = val.replace(/\bmin\b/g, 'min').replace(/\bseg\b/g, 'sec');
  return val;
}

function formatearFecha(createdAt: string, idioma: Idioma): string | undefined {
  if (!createdAt) return undefined;
  const dt = new Date(createdAt);
  if (isNaN(dt.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat(idioma === 'en' ? 'en-US' : 'es-MX', {
      day: 'numeric', month: 'long', year: 'numeric',
    }).format(dt);
  } catch {
    return undefined;
  }
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
  const destinatarios = await destinatariosValidos(env.DB, invitees, origen.email);
  if (destinatarios.length === 0) {
    await upsertResumen(env.DB, {
      recording_id, status: 'sin_destinatarios',
      procesado_en: new Date().toISOString(),
    });
    await insertLog(env.DB, 'WARNING', `Sin destinatarios con email válido (o solo el propio origen / bloqueados) — no se envía correo: ${title}`, recording_id);
    await trimLogs(env.DB);
    return;
  }

  // 3) Generar el resumen con Workers AI — si falla, dejamos que la cola reintente (aún no se envió nada)
  let resultado: Awaited<ReturnType<typeof generarResumen>>;
  try {
    resultado = await generarResumen(env, { title, created_at, origenNombre: origen.nombre }, contenido);
  } catch (e: any) {
    await insertLog(env.DB, 'ERROR', `Fallo generando resumen [${title}]: ${e?.message ?? e}`, recording_id);
    throw e;
  }
  const { texto: resumenTexto, tono, idioma } = resultado;

  await upsertResumen(env.DB, { recording_id, resumen_texto: resumenTexto, tono, idioma });
  await insertLog(env.DB, 'INFO', `✓ Resumen generado (tono: ${tono}, idioma: ${idioma}): ${title || recording_id}`, recording_id);

  // 3.5) Si la llamada fue tensa / con una queja real, no se manda solo al
  // cliente — se retiene para que el admin lo apruebe primero.
  if (tono === 'tenso') {
    await upsertResumen(env.DB, {
      recording_id,
      destinatarios: JSON.stringify(destinatarios.map(p => p.email)),
      status: 'en_revision',
      procesado_en: new Date().toISOString(),
    });
    await insertLog(env.DB, 'WARNING', `⏸ Tono tenso detectado — retenido para revisión: ${title}`, recording_id);
    await enviarBorradorParaRevision(env, {
      folder, recordingId: recording_id, title,
      origenNombre: origen.nombre, origenEmail: origen.email,
      destinatarios: destinatarios.map(p => p.email!),
      resumenTexto,
    }).catch(() => {});
    await trimLogs(env.DB);
    return;
  }

  await enviarYRegistrar(env, {
    folder, recordingId: recording_id, title, shareUrl: share_url,
    origen, destinatarios, resumenTexto, idioma,
    fechaLegible: formatearFecha(created_at, idioma),
    duracion: extraerDuracion(contenido, idioma),
  });
}

/**
 * Envía a cada destinatario y deja el registro final en D1 — usado tanto por
 * el flujo normal como por /aprobar (cuando un borrador retenido se aprueba).
 */
async function enviarYRegistrar(env: Env, params: {
  folder: string;
  recordingId: string;
  title: string;
  shareUrl: string;
  origen: { nombre: string; email: string };
  destinatarios: ResumenPersona[];
  resumenTexto: string;
  idioma: Idioma;
  fechaLegible?: string;
  duracion?: string;
}): Promise<void> {
  const { folder, recordingId, title, shareUrl, origen, destinatarios, resumenTexto, idioma, fechaLegible, duracion } = params;

  // A partir de aquí NO relanzamos errores: un fallo parcial no debe reintentar
  // el mensaje completo (duplicaría correos ya enviados con éxito).
  let enviados = 0;
  const errores: string[] = [];
  const resendIds: Record<string, string> = {};
  for (const persona of destinatarios) {
    const resultado = await sendResumenEmail(env, {
      to: persona.email!,
      nombreDestino: persona.nombre ?? '',
      nombreOrigen: origen.nombre,
      origenNombre: origen.nombre,
      origenEmail: origen.email,
      title,
      shareUrl,
      resumenTexto,
      idioma,
      fechaLegible,
      duracion,
    });
    if (resultado.ok) {
      enviados++;
      if (resultado.id) {
        resendIds[persona.email!] = resultado.id;
        await registrarEnvio(env.DB, { resendId: resultado.id, recordingId, email: persona.email! });
      }
      await insertLog(env.DB, 'INFO', `  ✉ Enviado a ${persona.email} desde ${origen.email} (id: ${resultado.id})`, recordingId);
    } else {
      errores.push(`${persona.email}: ${resultado.error}`);
      await insertLog(env.DB, 'ERROR', `  ✗ Falló envío a ${persona.email}: ${resultado.error}`, recordingId);
    }
  }

  const status = enviados > 0 ? 'enviado' : 'error';
  await upsertResumen(env.DB, {
    recording_id: recordingId,
    destinatarios: JSON.stringify(destinatarios.map(p => p.email)),
    resend_id: JSON.stringify(resendIds),
    status,
    error: errores.length ? errores.join(' | ') : null,
    procesado_en: new Date().toISOString(),
  });

  await insertLog(env.DB, 'INFO', `Resumen [${title}]: ${enviados}/${destinatarios.length} correos enviados`, recordingId);

  if (status === 'error') {
    await enviarAlertaAdmin(env, { folder, recordingId, title, errores }).catch(() => {});
  }

  await trimLogs(env.DB);
}

/** Aprueba un borrador retenido (tono tenso) y lo envía a los destinatarios ya calculados. */
export async function aprobarResumenRetenido(env: Env, recordingId: string): Promise<{ ok: boolean; error?: string }> {
  const row = await env.DB.prepare('SELECT * FROM resumenes WHERE recording_id = ?').bind(recordingId)
    .first<{ folder: string; title: string; share_url: string; resumen_texto: string; destinatarios: string; origen_nombre: string; origen_email: string; idioma: string; status: string }>();
  if (!row) return { ok: false, error: 'No existe ese resumen' };
  if (row.status !== 'en_revision') return { ok: false, error: `Este resumen no está esperando aprobación (status actual: ${row.status})` };

  let destinatarios: ResumenPersona[] = [];
  try { destinatarios = (JSON.parse(row.destinatarios || '[]') as string[]).map(email => ({ email })); } catch {}
  if (!destinatarios.length) return { ok: false, error: 'No hay destinatarios guardados para este resumen' };

  await enviarYRegistrar(env, {
    folder: row.folder, recordingId, title: row.title, shareUrl: row.share_url,
    origen: { nombre: row.origen_nombre, email: row.origen_email },
    destinatarios, resumenTexto: row.resumen_texto,
    idioma: (row.idioma as Idioma) || 'es',
  });
  return { ok: true };
}
