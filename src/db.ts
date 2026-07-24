// RLR
import type { ResumenRecord, EstadoEnvio } from './types';

export async function hasResumen(db: D1Database, recordingId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM resumenes WHERE recording_id = ?').bind(recordingId).first();
  return row !== null;
}

export async function upsertResumen(db: D1Database, r: Partial<ResumenRecord> & { recording_id: string }): Promise<void> {
  const existing = await db.prepare('SELECT * FROM resumenes WHERE recording_id = ?')
    .bind(r.recording_id).first<ResumenRecord>();

  if (!existing) {
    await db.prepare(`
      INSERT INTO resumenes (recording_id, folder, title, created_at, share_url, resumen_texto, destinatarios, resend_id, origen_nombre, origen_email, tono, idioma, status, error, procesado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      r.recording_id,
      r.folder ?? '',
      r.title ?? null,
      r.created_at ?? null,
      r.share_url ?? null,
      r.resumen_texto ?? null,
      r.destinatarios ?? null,
      r.resend_id ?? null,
      r.origen_nombre ?? null,
      r.origen_email ?? null,
      r.tono ?? null,
      r.idioma ?? null,
      r.status ?? 'pendiente',
      r.error ?? null,
      r.procesado_en ?? null,
    ).run();
    return;
  }

  const merged = { ...existing, ...r };
  await db.prepare(`
    UPDATE resumenes SET folder=?, title=?, created_at=?, share_url=?, resumen_texto=?, destinatarios=?, resend_id=?, origen_nombre=?, origen_email=?, tono=?, idioma=?, status=?, error=?, procesado_en=?
    WHERE recording_id=?
  `).bind(
    merged.folder,
    merged.title,
    merged.created_at,
    merged.share_url,
    merged.resumen_texto,
    merged.destinatarios,
    merged.resend_id,
    merged.origen_nombre,
    merged.origen_email,
    merged.tono,
    merged.idioma,
    merged.status,
    merged.error,
    merged.procesado_en,
    merged.recording_id,
  ).run();
}

// ── Entregas (webhooks de Resend) ───────────────────────────────────────────

export async function registrarEnvio(db: D1Database, params: { resendId: string; recordingId: string; email: string }): Promise<void> {
  await db.prepare(`
    INSERT OR IGNORE INTO envios (resend_id, recording_id, email, estado, actualizado)
    VALUES (?, ?, ?, 'enviado', ?)
  `).bind(params.resendId, params.recordingId, params.email, new Date().toISOString()).run();
}

export async function actualizarEstadoEnvio(db: D1Database, resendId: string, estado: EstadoEnvio, detalle?: string): Promise<{ recordingId: string; email: string } | null> {
  const row = await db.prepare('SELECT recording_id, email FROM envios WHERE resend_id = ?')
    .bind(resendId).first<{ recording_id: string; email: string }>();
  if (!row) return null;

  await db.prepare('UPDATE envios SET estado=?, detalle=?, actualizado=? WHERE resend_id=?')
    .bind(estado, detalle ?? null, new Date().toISOString(), resendId).run();

  return { recordingId: row.recording_id, email: row.email };
}

export async function estaBloqueado(db: D1Database, email: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM bloqueados WHERE email = ?').bind(email.toLowerCase()).first();
  return row !== null;
}

export async function bloquearEmail(db: D1Database, email: string, motivo: 'rebote' | 'queja', detalle?: string): Promise<void> {
  await db.prepare(`
    INSERT INTO bloqueados (email, motivo, detalle, bloqueado_en)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET motivo=excluded.motivo, detalle=excluded.detalle, bloqueado_en=excluded.bloqueado_en
  `).bind(email.toLowerCase(), motivo, detalle ?? null, new Date().toISOString()).run();
}

export async function listBloqueados(db: D1Database, limit = 100): Promise<{ email: string; motivo: string; detalle: string | null; bloqueado_en: string }[]> {
  const { results } = await db.prepare(
    'SELECT email, motivo, detalle, bloqueado_en FROM bloqueados ORDER BY bloqueado_en DESC LIMIT ?'
  ).bind(limit).all();
  return results as any;
}

export async function desbloquearEmail(db: D1Database, email: string): Promise<void> {
  await db.prepare('DELETE FROM bloqueados WHERE email = ?').bind(email.toLowerCase()).run();
}

/**
 * Reconstruye un ResumenTriggerMessage completo consultando fanthom-superleads
 * (solo lectura) — permite reintentar un resumen sin depender del mensaje
 * original de la cola, que ya no existe una vez procesado.
 */
export async function reconstruirTrigger(
  fanthomDb: D1Database,
  folder: string,
  recordingId: string,
): Promise<import('./types').ResumenTriggerMessage | null> {
  const meeting = await fanthomDb.prepare(
    'SELECT filename, title, created_at, share_url, recorded_by, invitees FROM meetings WHERE folder = ? AND recording_id = ?'
  ).bind(folder, recordingId).first<{
    filename: string; title: string | null; created_at: string | null;
    share_url: string | null; recorded_by: string | null; invitees: string | null;
  }>();
  if (!meeting) return null;

  const colab = await fanthomDb.prepare(
    'SELECT nombre, email FROM colaboradores WHERE folder = ?'
  ).bind(folder).first<{ nombre: string; email: string | null }>();

  const parseJson = <T>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try { return JSON.parse(s) as T; } catch { return fallback; }
  };

  return {
    folder,
    recording_id: recordingId,
    r2_key: `${folder}/${meeting.filename}`,
    title: meeting.title ?? '',
    created_at: meeting.created_at ?? '',
    share_url: meeting.share_url ?? '',
    recorded_by: parseJson(meeting.recorded_by, null),
    invitees: parseJson(meeting.invitees, []),
    colaborador_nombre: colab?.nombre,
    colaborador_email: colab?.email ?? null,
  };
}

export async function listResumenes(db: D1Database, limit = 50): Promise<ResumenRecord[]> {
  const { results } = await db.prepare(
    'SELECT * FROM resumenes ORDER BY procesado_en DESC LIMIT ?'
  ).bind(limit).all<ResumenRecord>();
  return results;
}

export async function insertLog(
  db: D1Database,
  level: 'INFO' | 'WARNING' | 'ERROR',
  message: string,
  recordingId?: string,
): Promise<void> {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await db.prepare('INSERT INTO logs (ts, level, message, recording_id) VALUES (?, ?, ?, ?)')
    .bind(ts, level, message, recordingId ?? null)
    .run();
}

export async function getLogs(db: D1Database, lines = 80): Promise<string> {
  const { results } = await db.prepare(
    'SELECT ts, level, message FROM logs ORDER BY id DESC LIMIT ?'
  ).bind(lines).all<{ ts: string; level: string; message: string }>();
  return results.reverse().map(r => `${r.ts}  ${r.level.padEnd(7)}  ${r.message}`).join('\n');
}

export async function trimLogs(db: D1Database, keep = 2000): Promise<void> {
  await db.prepare(`
    DELETE FROM logs WHERE id NOT IN (
      SELECT id FROM logs ORDER BY id DESC LIMIT ?
    )
  `).bind(keep).run();
}
