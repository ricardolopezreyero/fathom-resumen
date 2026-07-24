// RLR
import type { Env, ResumenTriggerMessage, ResumenRecord } from './types';
import { listResumenes, getLogs, insertLog, reconstruirTrigger, upsertResumen, listBloqueados, desbloquearEmail } from './db';
import { handleResumenMessage, MAX_INTENTOS_COLA, aprobarResumenRetenido } from './queue-handler';
import { enviarAlertaAdmin } from './email';
import { verificarFirmaResend, procesarEventoResend } from './resend-webhook';

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
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
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

      // GET /bloqueados — direcciones que rebotaron o se quejaron (ya no se les escribe solo)
      if (method === 'GET' && pathname === '/bloqueados') {
        const bloqueados = await listBloqueados(env.DB);
        return json({ bloqueados });
      }

      // DELETE /bloqueados/:email — desbloquear manualmente (p.ej. rebote temporal ya resuelto)
      if (method === 'DELETE' && pathname.startsWith('/bloqueados/')) {
        const email = decodeURIComponent(pathname.slice('/bloqueados/'.length));
        await desbloquearEmail(env.DB, email);
        await insertLog(env.DB, 'INFO', `Desbloqueado manualmente: ${email}`);
        return json({ ok: true });
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

      // GET|POST /aprobar/:recording_id — aprueba un borrador retenido por
      // tono tenso/queja y lo envía a los destinatarios ya calculados. GET
      // también funciona para que el link del correo de alerta sea un click.
      if ((method === 'POST' || method === 'GET') && pathname.startsWith('/aprobar/')) {
        const recordingId = pathname.slice('/aprobar/'.length);
        if (!recordingId) return json({ error: 'Uso: /aprobar/:recording_id' }, 400);

        const resultado = await aprobarResumenRetenido(env, recordingId);
        if (!resultado.ok) return json({ error: resultado.error }, 409);

        await insertLog(env.DB, 'INFO', `▶ Borrador aprobado y enviado`, recordingId);
        return json({ ok: true });
      }

      // POST /webhooks/resend — eventos de entrega/rebote/queja de Resend.
      // Firmado con Svix; ver src/resend-webhook.ts.
      if (method === 'POST' && pathname === '/webhooks/resend') {
        const body = await request.text();
        const firmaValida = await verificarFirmaResend(env.RESEND_WEBHOOK_SECRET, {
          svixId: request.headers.get('svix-id'),
          svixTimestamp: request.headers.get('svix-timestamp'),
          svixSignature: request.headers.get('svix-signature'),
        }, body);

        if (!firmaValida) {
          await insertLog(env.DB, 'WARNING', 'Webhook de Resend con firma inválida — descartado');
          return json({ error: 'Firma inválida' }, 403);
        }

        let evento: { type: string; data?: { email_id?: string } };
        try {
          evento = JSON.parse(body);
        } catch {
          return json({ error: 'Payload no es JSON válido' }, 400);
        }

        await procesarEventoResend(env, evento);
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
        const error = e?.message ?? String(e);
        // Cloudflare reintenta hasta max_retries (ver wrangler.toml) y luego
        // descarta el mensaje EN SILENCIO. Antes de que eso pase, en el
        // último intento dejamos constancia y avisamos — así ningún fallo
        // se pierde sin que alguien se entere.
        if (msg.attempts >= MAX_INTENTOS_COLA) {
          const { folder, recording_id, title } = msg.body ?? {};
          await insertLog(env.DB, 'ERROR', `✗✗ Agotados ${MAX_INTENTOS_COLA} intentos, se descarta: ${error}`, recording_id).catch(() => {});
          if (recording_id) {
            await upsertResumen(env.DB, {
              recording_id, folder: folder ?? '', title,
              status: 'error', error: `Agotados los reintentos: ${error}`,
              procesado_en: new Date().toISOString(),
            }).catch(() => {});
            await enviarAlertaAdmin(env, {
              folder: folder ?? '(desconocido)', recordingId: recording_id,
              title: title ?? recording_id,
              errores: [`Se agotaron los ${MAX_INTENTOS_COLA} intentos automáticos sin generar el resumen: ${error}`],
            }).catch(() => {});
          }
          msg.ack(); // ya no tiene caso que Cloudflare lo siga reintentando
        } else {
          await insertLog(env.DB, 'ERROR', `Reintentando mensaje (intento ${msg.attempts}/${MAX_INTENTOS_COLA}): ${error}`, msg.body?.recording_id).catch(() => {});
          msg.retry();
        }
      }
    }
  },
};
