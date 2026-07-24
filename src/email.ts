// RLR
import type { Env } from './types';
import type { Idioma } from './summarize';

// Dirección de respaldo cuando una reunión no trae ningún correo de origen
// confiable (ni colaborador registrado ni recorded_by de Fathom). También es
// quien recibe las alertas administrativas y los borradores para revisión.
export const ADMIN_EMAIL = 'Ricardo@SuperLeads.mx';
const ADMIN_FROM = 'SuperLeads — Alertas <alertas@superleads.mx>';
const DASHBOARD_URL = 'https://resumen.fathom.superleads.mx';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_INTENTOS = 3;
const REINTENTO_MS = [800, 2500];

const TEXTOS: Record<Idioma, {
  hola: (nombre: string) => string;
  intro: (title: string) => string;
  proximosPasos: string;
  grabacion: (url: string) => string;
  duda: string;
  saludos: string;
  footer: string;
}> = {
  es: {
    hola: nombre => nombre ? `Hola ${nombre},` : 'Hola,',
    intro: title => `Te dejo un resumen breve de nuestra conversación${title ? ` — ${title}` : ''}:`,
    proximosPasos: 'Próximos pasos',
    grabacion: url => `Si quieres repasar algún detalle, aquí tienes la grabación completa: ${url}`,
    duda: 'Cualquier duda o comentario, con toda confianza responde este correo.',
    saludos: 'Saludos,',
    footer: 'Resumen generado automáticamente a partir de la grabación de la reunión.',
  },
  en: {
    hola: nombre => nombre ? `Hi ${nombre},` : 'Hi,',
    intro: title => `Here's a quick summary of our conversation${title ? ` — ${title}` : ''}:`,
    proximosPasos: 'Next steps',
    grabacion: url => `If you'd like to revisit anything, here's the full recording: ${url}`,
    duda: 'Any questions or comments, feel free to just reply to this email.',
    saludos: 'Best,',
    footer: 'This summary was generated automatically from the meeting recording.',
  },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Convierte el texto plano estructurado (párrafos + líneas "- ") a HTML simple y seguro.
function bodyToHtml(text: string): string {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p style="margin:0 0 16px;">${escapeHtml(paragraph.join(' ')).trim()}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(`<ul style="margin:0 0 16px;padding-left:20px;">${list.map(li => `<li style="margin-bottom:6px;">${escapeHtml(li)}</li>`).join('')}</ul>`);
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    if (line.startsWith('- ')) {
      flushParagraph();
      list.push(line.slice(2).trim());
    } else if (/^(Próximos pasos|Next steps):?$/.test(line)) {
      flushParagraph(); flushList();
      blocks.push(`<p style="margin:20px 0 8px;font-weight:600;color:#1a2b4c;">${escapeHtml(line.replace(/:$/, ''))}</p>`);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();

  return blocks.join('\n');
}

interface CamposCorreo {
  nombreDestino: string;
  nombreOrigen: string;
  title: string;
  shareUrl: string;
  resumenTexto: string;
  idioma: Idioma;
  fechaLegible?: string;
  duracion?: string;
}

function metaLineaHtml(fechaLegible?: string, duracion?: string): string {
  const partes = [fechaLegible, duracion].filter((s): s is string => Boolean(s));
  if (!partes.length) return '';
  return `<p style="margin:-12px 0 20px;font-size:12.5px;color:#9aa2b1;">${partes.map(escapeHtml).join(' · ')}</p>`;
}

export function buildEmailHtml(params: CamposCorreo): string {
  const { nombreDestino, nombreOrigen, title, shareUrl, resumenTexto, idioma, fechaLegible, duracion } = params;
  const t = TEXTOS[idioma] ?? TEXTOS.es;
  const saludo = t.hola(escapeHtml(nombreDestino.split(' ')[0] || ''));
  const firma = nombreOrigen ? nombreOrigen.split(' ')[0] : (idioma === 'en' ? 'Best' : 'Saludos');
  const bodyHtml = bodyToHtml(resumenTexto);

  const grabacionHtml = shareUrl
    ? `<p style="margin:20px 0 0;font-size:14px;color:#5b6472;">${t.grabacion(`<a href="${escapeHtml(shareUrl)}" style="color:#3457d5;">${idioma === 'en' ? 'view recording' : 'ver reunión'}</a>`)}</p>`
    : '';

  return `<!-- RLR -->
<!doctype html>
<html lang="${idioma}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="author" content="Ricardo López Reyero"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 8px;">
              <p style="margin:0 0 20px;font-size:15px;color:#1a2b4c;">${saludo}</p>
              <p style="margin:0 0 4px;font-size:15px;line-height:1.6;color:#2b3646;">${t.intro(title ? `<em>${escapeHtml(title)}</em>` : '')}</p>
              ${metaLineaHtml(fechaLegible, duracion)}
              <div style="font-size:15px;line-height:1.6;color:#2b3646;">
                ${bodyHtml}
              </div>
              ${grabacionHtml}
              <p style="margin:28px 0 0;font-size:15px;line-height:1.6;color:#2b3646;">${t.duda}</p>
              <p style="margin:20px 0 0;font-size:15px;color:#2b3646;">${t.saludos}<br>${escapeHtml(firma)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #eef0f3;">
              <p style="margin:0;font-size:12px;color:#9aa2b1;">${t.footer}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildEmailText(params: CamposCorreo): string {
  const { nombreDestino, nombreOrigen, title, shareUrl, resumenTexto, idioma, fechaLegible, duracion } = params;
  const t = TEXTOS[idioma] ?? TEXTOS.es;
  const firma = nombreOrigen ? nombreOrigen.split(' ')[0] : (idioma === 'en' ? 'Best' : 'Saludos');
  const meta = [fechaLegible, duracion].filter(Boolean).join(' · ');

  const partes = [
    t.hola(nombreDestino.split(' ')[0] || ''),
    '',
    t.intro(title),
  ];
  if (meta) partes.push(meta);
  partes.push('', resumenTexto);
  if (shareUrl) partes.push('', t.grabacion(shareUrl));
  partes.push('', t.duda, '', t.saludos, firma);
  return partes.join('\n');
}

async function llamarResend(env: Env, body: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> {
  for (let intento = 0; intento < MAX_INTENTOS; intento++) {
    try {
      const r = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (r.ok) {
        const data = await r.json() as { id?: string };
        return { ok: true, id: data.id };
      }

      const errBody = await r.text();
      // 429 (rate limit) y 5xx son transitorios — vale la pena reintentar.
      const esTransitorio = r.status === 429 || r.status >= 500;
      if (esTransitorio && intento < MAX_INTENTOS - 1) {
        await sleep(REINTENTO_MS[Math.min(intento, REINTENTO_MS.length - 1)]);
        continue;
      }
      return { ok: false, error: `Resend ${r.status}: ${errBody}` };
    } catch (e: any) {
      if (intento < MAX_INTENTOS - 1) {
        await sleep(REINTENTO_MS[Math.min(intento, REINTENTO_MS.length - 1)]);
        continue;
      }
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
  return { ok: false, error: 'Agotados los reintentos de envío' };
}

/**
 * Envía el correo de resumen. `origen` es siempre la persona/cuenta dueña de
 * la transcripción (el colaborador registrado, o recorded_by de Fathom como
 * respaldo) — el "De" del correo es siempre ese origen, nunca un remitente
 * fijo, para que las respuestas lleguen a quien realmente tuvo la llamada.
 */
export async function sendResumenEmail(env: Env, params: {
  to: string;
  origenNombre: string;
  origenEmail: string;
} & CamposCorreo): Promise<{ ok: boolean; id?: string; error?: string }> {
  const t = TEXTOS[params.idioma] ?? TEXTOS.es;
  const subject = params.title
    ? `${params.idioma === 'en' ? 'Summary of our conversation' : 'Resumen de nuestra conversación'}: ${params.title}`
    : (params.idioma === 'en' ? 'Summary of our conversation' : 'Resumen de nuestra conversación');

  const html = buildEmailHtml(params);
  const text = buildEmailText(params);
  const from = params.origenNombre ? `${params.origenNombre} <${params.origenEmail}>` : params.origenEmail;

  return llamarResend(env, {
    from,
    to: [params.to],
    reply_to: params.origenEmail,
    subject,
    html,
    text,
  });
}

/** Alerta interna simple cuando un resumen no se pudo enviar a nadie — para que un fallo no pase inadvertido por meses. */
export async function enviarAlertaAdmin(env: Env, params: {
  folder: string;
  recordingId: string;
  title: string;
  errores: string[];
}): Promise<void> {
  const cuerpo = [
    `No se pudo enviar el correo de resumen para una reunión.`,
    '',
    `Colaborador (folder): ${params.folder}`,
    `Reunión: ${params.title || '(sin título)'}`,
    `recording_id: ${params.recordingId}`,
    '',
    'Errores:',
    ...params.errores.map(e => `- ${e}`),
    '',
    `Puedes reintentarlo manualmente en: ${DASHBOARD_URL}/reintentar/${params.folder}/${params.recordingId}`,
  ].join('\n');

  await llamarResend(env, {
    from: ADMIN_FROM,
    to: [ADMIN_EMAIL],
    subject: `⚠ Falló el envío de un resumen: ${params.title || params.recordingId}`,
    text: cuerpo,
  });
}

/**
 * Cuando el motor detecta una llamada tensa/con queja, no se envía sola al
 * cliente — se manda este borrador al admin para que decida si aprobarla tal
 * cual, editarla a mano y reenviar, o dejarla sin enviar.
 */
export async function enviarBorradorParaRevision(env: Env, params: {
  folder: string;
  recordingId: string;
  title: string;
  origenNombre: string;
  origenEmail: string;
  destinatarios: string[];
  resumenTexto: string;
}): Promise<void> {
  const cuerpo = [
    `Esta llamada se detectó con tono tenso/con una queja real, así que el correo NO se envió solo al cliente — queda a tu criterio.`,
    '',
    `Colaborador: ${params.origenNombre} <${params.origenEmail}>`,
    `Reunión: ${params.title || '(sin título)'}`,
    `Se enviaría a: ${params.destinatarios.join(', ')}`,
    '',
    '── Borrador ──',
    '',
    params.resumenTexto,
    '── fin del borrador ──',
    '',
    `Si el borrador te parece bien tal cual, apruébalo aquí: ${DASHBOARD_URL}/aprobar/${params.recordingId}`,
    `(o entra al dashboard para revisarlo con más calma: ${DASHBOARD_URL})`,
  ].join('\n');

  await llamarResend(env, {
    from: ADMIN_FROM,
    to: [ADMIN_EMAIL],
    subject: `🕵️ Revisar antes de enviar — llamada tensa: ${params.title || params.recordingId}`,
    text: cuerpo,
  });
}
