import type { ResumenRecord } from './types';

export async function hasResumen(db: D1Database, recordingId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM resumenes WHERE recording_id = ?').bind(recordingId).first();
  return row !== null;
}

export async function upsertResumen(db: D1Database, r: Partial<ResumenRecord> & { recording_id: string }): Promise<void> {
  const existing = await db.prepare('SELECT * FROM resumenes WHERE recording_id = ?')
    .bind(r.recording_id).first<ResumenRecord>();

  if (!existing) {
    await db.prepare(`
      INSERT INTO resumenes (recording_id, folder, title, created_at, share_url, resumen_texto, destinatarios, resend_id, status, error, procesado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      r.recording_id,
      r.folder ?? '',
      r.title ?? null,
      r.created_at ?? null,
      r.share_url ?? null,
      r.resumen_texto ?? null,
      r.destinatarios ?? null,
      r.resend_id ?? null,
      r.status ?? 'pendiente',
      r.error ?? null,
      r.procesado_en ?? null,
    ).run();
    return;
  }

  const merged = { ...existing, ...r };
  await db.prepare(`
    UPDATE resumenes SET folder=?, title=?, created_at=?, share_url=?, resumen_texto=?, destinatarios=?, resend_id=?, status=?, error=?, procesado_en=?
    WHERE recording_id=?
  `).bind(
    merged.folder,
    merged.title,
    merged.created_at,
    merged.share_url,
    merged.resumen_texto,
    merged.destinatarios,
    merged.resend_id,
    merged.status,
    merged.error,
    merged.procesado_en,
    merged.recording_id,
  ).run();
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
