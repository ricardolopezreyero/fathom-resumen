// RLR
import type { Env } from './types';

const FROM_ADDRESS = 'Ricardo · SuperLeads <ricardo@videoroom.live>';
const REPLY_TO = 'Ricardo@SuperLeads.mx';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    } else if (line === 'Próximos pasos' || line === 'Próximos pasos:') {
      flushParagraph(); flushList();
      blocks.push(`<p style="margin:20px 0 8px;font-weight:600;color:#1a2b4c;">Próximos pasos</p>`);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();

  return blocks.join('\n');
}

export function buildEmailHtml(params: {
  nombreDestino: string;
  title: string;
  shareUrl: string;
  resumenTexto: string;
}): string {
  const { nombreDestino, title, shareUrl, resumenTexto } = params;
  const saludo = nombreDestino ? `Hola ${escapeHtml(nombreDestino.split(' ')[0])},` : 'Hola,';
  const bodyHtml = bodyToHtml(resumenTexto);

  const grabacionHtml = shareUrl
    ? `<p style="margin:20px 0 0;font-size:14px;color:#5b6472;">Si quieres repasar algún detalle, aquí tienes la grabación completa: <a href="${escapeHtml(shareUrl)}" style="color:#3457d5;">ver reunión</a>.</p>`
    : '';

  return `<!-- RLR -->
<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="author" content="Ricardo López Reyero"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 8px;">
              <p style="margin:0 0 20px;font-size:15px;color:#1a2b4c;">${saludo}</p>
              <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#2b3646;">Te dejo un resumen breve de nuestra conversación${title ? ` — <em>${escapeHtml(title)}</em>` : ''}:</p>
              <div style="font-size:15px;line-height:1.6;color:#2b3646;">
                ${bodyHtml}
              </div>
              ${grabacionHtml}
              <p style="margin:28px 0 0;font-size:15px;line-height:1.6;color:#2b3646;">Cualquier duda o comentario, con toda confianza responde este correo.</p>
              <p style="margin:20px 0 0;font-size:15px;color:#2b3646;">Saludos,<br>Ricardo</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #eef0f3;">
              <p style="margin:0;font-size:12px;color:#9aa2b1;">Resumen generado automáticamente a partir de la grabación de la reunión.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildEmailText(params: {
  nombreDestino: string;
  title: string;
  shareUrl: string;
  resumenTexto: string;
}): string {
  const { nombreDestino, title, shareUrl, resumenTexto } = params;
  const saludo = nombreDestino ? `Hola ${nombreDestino.split(' ')[0]},` : 'Hola,';
  const partes = [
    saludo,
    '',
    `Te dejo un resumen breve de nuestra conversación${title ? ` — ${title}` : ''}:`,
    '',
    resumenTexto,
  ];
  if (shareUrl) {
    partes.push('', `Si quieres repasar algún detalle, aquí tienes la grabación completa: ${shareUrl}`);
  }
  partes.push('', 'Cualquier duda o comentario, con toda confianza responde este correo.', '', 'Saludos,', 'Ricardo');
  return partes.join('\n');
}

export async function sendResumenEmail(env: Env, params: {
  to: string;
  nombreDestino: string;
  title: string;
  shareUrl: string;
  resumenTexto: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const subject = params.title
    ? `Resumen de nuestra conversación: ${params.title}`
    : 'Resumen de nuestra conversación';

  const html = buildEmailHtml(params);
  const text = buildEmailText(params);

  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [params.to],
        reply_to: REPLY_TO,
        subject,
        html,
        text,
      }),
    });

    if (!r.ok) {
      const errBody = await r.text();
      return { ok: false, error: `Resend ${r.status}: ${errBody}` };
    }

    const data = await r.json() as { id?: string };
    return { ok: true, id: data.id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
