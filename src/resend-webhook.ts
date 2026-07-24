// RLR
import type { Env, EstadoEnvio } from './types';
import { actualizarEstadoEnvio, bloquearEmail, insertLog } from './db';

const TOLERANCIA_TIMESTAMP_SEG = 5 * 60;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

/**
 * Verifica la firma Svix que usa Resend en sus webhooks.
 * https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 */
export async function verificarFirmaResend(
  secret: string,
  headers: { svixId: string | null; svixTimestamp: string | null; svixSignature: string | null },
  body: string,
): Promise<boolean> {
  const { svixId, svixTimestamp, svixSignature } = headers;
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCIA_TIMESTAMP_SEG) return false;

  const secretBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
  const cryptoKey = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(sigBuf);

  // svix-signature trae una o más firmas separadas por espacio: "v1,<base64> v1,<base64> ..."
  const candidatos = svixSignature.split(' ').map(s => s.split(',')[1]).filter(Boolean);
  return candidatos.some(c => c === expected);
}

interface EventoResend {
  type: string;
  data?: { email_id?: string; to?: string[] | string };
}

const MAPA_ESTADO: Record<string, EstadoEnvio | undefined> = {
  'email.delivered': 'entregado',
  'email.bounced': 'rebotado',
  'email.complained': 'quejado',
  'email.delivery_delayed': 'retrasado',
};

export async function procesarEventoResend(env: Env, evento: EventoResend): Promise<void> {
  const estado = MAPA_ESTADO[evento.type];
  const resendId = evento.data?.email_id;
  if (!estado || !resendId) return; // otros eventos (sent, opened, clicked) no nos interesan

  const info = await actualizarEstadoEnvio(env.DB, resendId, estado, evento.type);
  if (!info) return; // evento de un correo que no rastreamos (p.ej. alertas al admin)

  if (estado === 'rebotado' || estado === 'quejado') {
    const motivo = estado === 'rebotado' ? 'rebote' : 'queja';
    await bloquearEmail(env.DB, info.email, motivo, `Detectado vía webhook Resend en reunión ${info.recordingId}`);
    await insertLog(
      env.DB, 'WARNING',
      `⛔ ${info.email} bloqueado (${motivo}) — no se le volverá a escribir automáticamente`,
      info.recordingId,
    );
  }
}
