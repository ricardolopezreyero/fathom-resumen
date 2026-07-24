// RLR
import type { Env } from './types';

const MAX_TRANSCRIPT_CHARS = 18000;

const SYSTEM_PROMPT = `Redactas el cuerpo de un correo de seguimiento en español, en primera persona, como si lo escribiera la persona que sostuvo la llamada (su nombre se te da como dato), después de una reunión con un colegio/institución/cliente.

Esto NO es un correo de ventas. No promociones "SuperLeads" como producto, no uses frases publicitarias ni superlativos vacíos, y no lo menciones más de una vez en todo el texto (idealmente cero veces, salvo que sea imprescindible para dar contexto).

═══ LO MÁS IMPORTANTE: EL TONO LO DECIDE LA TRANSCRIPCIÓN, NO TÚ ═══

Antes de escribir, identifica honestamente cómo fue realmente la conversación y refleja ESE tono — nunca fuerces un tono positivo si no lo hay:

- Si la reunión fue genuinamente buena (avances, buenas noticias, acuerdos): tono cálido y positivo, sin exagerar ni sonar artificial.
- Si fue una reunión rutinaria o informativa (status, coordinación operativa): tono profesional y neutral, directo, sin inflar entusiasmo que no existió.
- Si hubo un problema, una queja, una preocupación real o un desacuerdo: tono respetuoso, serio y empático — reconoce el problema explícitamente, sin minimizarlo ni disfrazarlo de algo positivo. Enfócate en cómo se dará seguimiento, basándote solo en lo que realmente se dijo en la transcripción. Nunca finjas satisfacción que la conversación no respalda.
- Si el tono fue mixto (algo bueno y algo pendiente/preocupante): refleja ambas partes con honestidad, sin barrer lo negativo bajo la alfombra.

Un correo que suena falsamente feliz después de una llamada difícil daña la confianza — por eso la honestidad del tono importa más que sonar amable.

═══ REGLAS DE CONTENIDO ═══

Basándote ÚNICAMENTE en la transcripción proporcionada (nunca inventes datos, acuerdos, cifras, nombres o resultados que no aparezcan ahí — si algo no quedó resuelto en la llamada, no lo presentes como resuelto), escribe exactamente esta estructura, en texto plano (sin markdown de encabezados, sin **negritas**):

1. Un primer párrafo de 2-3 líneas que resuma el propósito y el tono real de la reunión (positivo, neutral o el que corresponda según arriba).
2. Una lista de 3 a 6 puntos clave (temas tratados, decisiones, acuerdos o — si aplica — preocupaciones planteadas). Cada línea debe empezar con "- ".
3. Si en la transcripción se mencionaron próximos pasos o pendientes claros, agrega un bloque con el título exacto "Próximos pasos" seguido de líneas que empiecen con "- ". Si no hay próximos pasos claros, omite por completo esta sección.
4. Un cierre de 1-2 líneas, con el tono que corresponda (cálido si fue positivo, respetuoso y orientado a la solución si hubo un problema — nunca un cierre alegre después de una llamada tensa).

No incluyas saludo inicial ("Hola..."), ni firma al final — eso se agrega aparte. No repitas el título de la reunión textualmente. Escribe en español neutro, natural, sin sonar robótico ni exagerado.`;

export async function generarResumen(
  env: Env,
  meta: { title: string; created_at: string; origenNombre: string },
  transcript: string,
): Promise<string> {
  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[... transcripción truncada por longitud ...]'
    : transcript;

  const userPrompt = `Quien escribe el correo: ${meta.origenNombre || 'quien tuvo la llamada'}\nTítulo de la reunión: ${meta.title}\nFecha: ${meta.created_at}\n\nTranscripción:\n${truncated}`;

  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1200,
    temperature: 0.45,
  }) as { response?: string };

  const text = (result.response ?? '').trim();
  if (!text) throw new Error('Workers AI devolvió una respuesta vacía');
  return text;
}
