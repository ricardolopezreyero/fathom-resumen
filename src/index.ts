// RLR
import type { Env, ResumenTriggerMessage, ResumenRecord } from './types';
import { listResumenes, getLogs, insertLog, reconstruirTrigger } from './db';
import { handleResumenMessage } from './queue-handler';

// Ricardo López Reyero
const _k = 'EYE', _rev = 181218;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

function notFound(): Response {
  return json({ error: 'No encontrado' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { method, pathname } = { method: request.method, pathname: url.pathname };

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
      });
    }

    try {
      // GET /resumenes — últimos resúmenes procesados (dashboard)
      if (method === 'GET' && pathname === '/resumenes') {
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const resumenes = await listResumenes(env.DB, limit);
        return json({ resumenes });
      }

      // GET /logs
      if (method === 'GET' && pathname === '/logs') {
        const lines = Number(url.searchParams.get('lines') ?? '80');
        const logs = await getLogs(env.DB, lines);
        return json({ logs });
      }

      // POST /probar — dispara manualmente el flujo completo con un mensaje de prueba
      // (útil para verificar el servicio end-to-end sin esperar un webhook real de Fathom)
      if (method === 'POST' && pathname === '/probar') {
        const body = await request.json() as ResumenTriggerMessage;
        if (!body?.recording_id || !body?.folder || !body?.r2_key) {
          return json({ error: 'Faltan campos: recording_id, folder, r2_key' }, 400);
        }
        await insertLog(env.DB, 'INFO', `▶ Prueba manual disparada: ${body.title ?? body.recording_id}`, body.recording_id);
        await handleResumenMessage(body, env);
        return json({ ok: true });
      }

      // POST /reintentar/:folder/:recording_id[?force=1] — reconstruye el
      // disparo desde fanthom-db (ya no depende del mensaje original de la
      // cola, que se pierde una vez procesado) y reprocesa. Por seguridad, si
      // ya se envió con éxito antes, exige ?force=1 para evitar duplicar
      // correos a un cliente real por error de operación.
      if (method === 'POST' && pathname.startsWith('/reintentar/')) {
        const partes = pathname.slice('/reintentar/'.length).split('/');
        const folder = partes[0];
        const recordingId = partes[1];
        if (!folder || !recordingId) return json({ error: 'Uso: /reintentar/:folder/:recording_id' }, 400);

        const existente = await env.DB.prepare('SELECT status FROM resumenes WHERE recording_id = ?')
          .bind(recordingId).first<Pick<ResumenRecord, 'status'>>();
        const force = url.searchParams.get('force') === '1';
        if (existente?.status === 'enviado' && !force) {
          return json({ error: 'Ya se envió con éxito anteriormente. Usa ?force=1 si de verdad quieres reenviarlo.' }, 409);
        }

        const trigger = await reconstruirTrigger(env.FANTHOM_DB, folder, recordingId);
        if (!trigger) return json({ error: 'No se encontró esa reunión en fanthom-db (folder/recording_id incorrectos, o es muy antigua)' }, 404);

        await insertLog(env.DB, 'INFO', `▶ Reintento manual: ${trigger.title || recordingId}`, recordingId);
        await handleResumenMessage(trigger, env, { force: true });
        return json({ ok: true });
      }

      return env.ASSETS.fetch(request);
    } catch (e: any) {
      await insertLog(env.DB, 'ERROR', `Error interno: ${e?.message ?? e}`).catch(() => {});
      return json({ error: e?.message ?? 'Error interno' }, 500);
    }
  },

  async queue(batch: MessageBatch<ResumenTriggerMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await handleResumenMessage(msg.body, env);
        msg.ack();
      } catch (e: any) {
        await insertLog(env.DB, 'ERROR', `Reintentando mensaje: ${e?.message ?? e}`, msg.body?.recording_id).catch(() => {});
        msg.retry();
      }
    }
  },
};
