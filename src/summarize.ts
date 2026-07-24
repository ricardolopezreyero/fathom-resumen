// RLR
import type { Env } from './types';

const MAX_TRANSCRIPT_CHARS = 18000;

export type Tono = 'positivo' | 'neutral' | 'tenso';
export type Idioma = 'es' | 'en';

// ── Detección de idioma por heurística ──────────────────────────────────────
// Pedirle al modelo que "detecte y escriba en ese idioma" dentro de un prompt
// redactado en español no funciona de forma confiable: el modelo ancla al
// idioma dominante del propio prompt del sistema y sigue respondiendo en
// español aunque declare idioma=en. La solución robusta es decidir el idioma
// nosotros mismos (barato, sin IA) y usar un prompt de sistema completo y
// nativo en ese idioma — así el modelo nunca tiene que "cambiar de idioma a
// mitad de instrucciones".

const PALABRAS_ES = [' que ', ' de ', ' la ', ' el ', ' los ', ' las ', ' para ', ' con ', ' está ', ' qué ', ' se ', ' una ', ' por ', ' más ', ' pero ', ' también ', ' bien ', ' así ', ' cómo ', ' nos ', ' muy '];
const PALABRAS_EN = [' the ', ' and ', ' is ', ' are ', ' that ', ' this ', ' with ', ' for ', ' was ', ' were ', ' have ', ' has ', ' will ', ' but ', ' also ', ' what ', ' you ', ' we ', ' just ', ' really '];

function detectarIdioma(transcript: string): Idioma {
  const marcador = '════════════════════════════════════════════════════════════';
  const idx = transcript.lastIndexOf(marcador);
  const cuerpo = (idx >= 0 ? transcript.slice(idx + marcador.length) : transcript).toLowerCase();
  const texto = ` ${cuerpo.replace(/[.,!?;:()"']/g, ' ')} `;

  const contar = (palabras: string[]) => palabras.reduce((n, p) => n + (texto.split(p).length - 1), 0);
  const puntajeEs = contar(PALABRAS_ES);
  const puntajeEn = contar(PALABRAS_EN);

  return puntajeEn > puntajeEs ? 'en' : 'es';
}

function buildSystemPrompt(idioma: Idioma): string {
  if (idioma === 'en') {
    return `You write the body of a follow-up email in first person, as if written by the person who was on the call (their name is given to you as data), after a meeting with a school/institution/client.

This is NOT a sales email. Don't promote "SuperLeads" as a product, don't use marketing language or empty superlatives, and don't mention it more than once in the whole text (ideally zero times, unless strictly needed for context).

═══ MOST IMPORTANT: THE TRANSCRIPT DECIDES THE TONE, NOT YOU ═══

Before writing, honestly identify how the conversation actually went and reflect THAT tone — never force a positive tone if there isn't one:

- If the meeting was genuinely good (progress, good news, agreements): warm and positive tone, without exaggerating or sounding artificial.
- If it was a routine or informational meeting (status, operational coordination): professional and neutral tone, direct, without inflating enthusiasm that wasn't there.
- If there was a real problem, complaint, concern, or disagreement: respectful, serious, and empathetic tone — acknowledge the problem explicitly, without minimizing it or dressing it up as something positive. Focus on how it will be followed up on, based only on what was actually said in the transcript. Never fake satisfaction the conversation doesn't support.
- If the tone was mixed (something good and something pending/concerning): reflect both honestly, without sweeping the negative under the rug.

An email that sounds falsely happy after a difficult call damages trust — that's why tonal honesty matters more than sounding nice.

═══ CONTENT RULES ═══

Based ONLY on the provided transcript (never invent data, agreements, figures, names, or outcomes that don't appear there — if something wasn't resolved on the call, don't present it as resolved), write exactly this structure for the body, in plain text (no markdown headers, no **bold**):

1. A first paragraph of 2-3 lines summarizing the purpose and real tone of the meeting.
2. A list of 3 to 6 key points (topics discussed, decisions, agreements, or — if applicable — concerns raised). Each line must start with "- ".
3. If clear next steps or pending items were mentioned, add a block with the exact title "Next steps" followed by lines starting with "- ". If there are no clear next steps, omit this section entirely.
4. A closing of 1-2 lines, with the appropriate tone (warm if positive, respectful and solution-oriented if there was a problem — never a cheerful closing after a tense call).

Do not include an opening greeting ("Hi..."), or a signature at the end — that's added separately. Don't repeat the meeting title verbatim. Write naturally, without sounding robotic or exaggerated. Write the entire response in English.

═══ REQUIRED RESPONSE FORMAT ═══

Your full response must start EXACTLY with this first line (nothing before it):

META: tono=<positivo|neutral|tenso>

Then a blank line, then the email body as described above, entirely in English. Use "tenso" only when there was a real problem, complaint, or disagreement — not for meetings that were simply serious or technical without conflict.`;
  }

  return `Redactas el cuerpo de un correo de seguimiento en primera persona, como si lo escribiera la persona que sostuvo la llamada (su nombre se te da como dato), después de una reunión con un colegio/institución/cliente.

Esto NO es un correo de ventas. No promociones "SuperLeads" como producto, no uses frases publicitarias ni superlativos vacíos, y no lo menciones más de una vez en todo el texto (idealmente cero veces, salvo que sea imprescindible para dar contexto).

═══ LO MÁS IMPORTANTE: EL TONO LO DECIDE LA TRANSCRIPCIÓN, NO TÚ ═══

Antes de escribir, identifica honestamente cómo fue realmente la conversación y refleja ESE tono — nunca fuerces un tono positivo si no lo hay:

- Si la reunión fue genuinamente buena (avances, buenas noticias, acuerdos): tono cálido y positivo, sin exagerar ni sonar artificial.
- Si fue una reunión rutinaria o informativa (status, coordinación operativa): tono profesional y neutral, directo, sin inflar entusiasmo que no existió.
- Si hubo un problema, una queja, una preocupación real o un desacuerdo: tono respetuoso, serio y empático — reconoce el problema explícitamente, sin minimizarlo ni disfrazarlo de algo positivo. Enfócate en cómo se dará seguimiento, basándote solo en lo que realmente se dijo en la transcripción. Nunca finjas satisfacción que la conversación no respalda.
- Si el tono fue mixto (algo bueno y algo pendiente/preocupante): refleja ambas partes con honestidad, sin barrer lo negativo bajo la alfombra.

Un correo que suena falsamente feliz después de una llamada difícil daña la confianza — por eso la honestidad del tono importa más que sonar amable.

═══ REGLAS DE CONTENIDO ═══

Basándote ÚNICAMENTE en la transcripción proporcionada (nunca inventes datos, acuerdos, cifras, nombres o resultados que no aparezcan ahí — si algo no quedó resuelto en la llamada, no lo presentes como resuelto), escribe exactamente esta estructura para el cuerpo, en texto plano (sin markdown de encabezados, sin **negritas**):

1. Un primer párrafo de 2-3 líneas que resuma el propósito y el tono real de la reunión.
2. Una lista de 3 a 6 puntos clave (temas tratados, decisiones, acuerdos o — si aplica — preocupaciones planteadas). Cada línea debe empezar con "- ".
3. Si se mencionaron próximos pasos o pendientes claros, agrega un bloque con el título exacto "Próximos pasos" seguido de líneas que empiecen con "- ". Si no hay próximos pasos claros, omite por completo esta sección.
4. Un cierre de 1-2 líneas, con el tono que corresponda (cálido si fue positivo, respetuoso y orientado a la solución si hubo un problema — nunca un cierre alegre después de una llamada tensa).

No incluyas saludo inicial ("Hola..."), ni firma al final — eso se agrega aparte. No repitas el título de la reunión textualmente. Escribe natural, sin sonar robótico ni exagerado. Escribe toda la respuesta en español.

═══ FORMATO DE RESPUESTA (obligatorio) ═══

Tu respuesta completa debe empezar EXACTAMENTE con esta primera línea (sin nada antes):

META: tono=<positivo|neutral|tenso>

Luego una línea en blanco, y después el cuerpo del correo como se describió arriba, íntegramente en español. "tenso" es solo para cuando hubo un problema, queja o desacuerdo real — no lo uses para reuniones simplemente serias o técnicas sin conflicto.`;
}

export interface ResultadoResumen {
  texto: string;
  tono: Tono;
  idioma: Idioma;
}

function parseMeta(raw: string): { tono: Tono; resto: string } {
  const lines = raw.split('\n');
  const primera = (lines[0] ?? '').trim();
  const m = primera.match(/^META:\s*tono=(positivo|neutral|tenso)/i);
  if (!m) {
    // El modelo no siguió el formato — degradamos con seguridad a neutral
    // en vez de fallar todo el envío por un detalle de formato.
    return { tono: 'neutral', resto: raw.trim() };
  }
  const resto = lines.slice(1).join('\n').replace(/^\s*\n/, '').trim();
  return { tono: m[1].toLowerCase() as Tono, resto };
}

export async function generarResumen(
  env: Env,
  meta: { title: string; created_at: string; origenNombre: string },
  transcript: string,
): Promise<ResultadoResumen> {
  const idioma = detectarIdioma(transcript);

  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + (idioma === 'en' ? '\n\n[... transcript truncated for length ...]' : '\n\n[... transcripción truncada por longitud ...]')
    : transcript;

  const userPrompt = idioma === 'en'
    ? `Who is writing the email: ${meta.origenNombre || 'whoever was on the call'}\nMeeting title: ${meta.title}\nDate: ${meta.created_at}\n\nTranscript:\n${truncated}`
    : `Quien escribe el correo: ${meta.origenNombre || 'quien tuvo la llamada'}\nTítulo de la reunión: ${meta.title}\nFecha: ${meta.created_at}\n\nTranscripción:\n${truncated}`;

  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: buildSystemPrompt(idioma) },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1300,
    temperature: 0.45,
  }) as { response?: string };

  const raw = (result.response ?? '').trim();
  if (!raw) throw new Error('Workers AI devolvió una respuesta vacía');

  const { tono, resto } = parseMeta(raw);
  if (!resto) throw new Error('Workers AI devolvió un resumen vacío tras quitar la línea META');

  return { texto: resto, tono, idioma };
}
