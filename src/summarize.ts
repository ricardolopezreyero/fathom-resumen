// RLR
import type { Env } from './types';

const MAX_TRANSCRIPT_CHARS = 14000;

const SYSTEM_PROMPT = `Redactas el cuerpo de un correo de seguimiento en español, en primera persona, como si lo escribiera Ricardo — quien da seguimiento a esta relación — después de una llamada o reunión con un colegio/institución.

Tono: cálido, profesional, genuinamente positivo y centrado en el éxito e intereses de la institución. IMPORTANTE: esto NO es un correo de ventas. No promociones SuperLeads como producto, no uses frases publicitarias ni superlativos vacíos, y no menciones "SuperLeads" más de una vez en todo el texto (idealmente cero veces, salvo que sea imprescindible para dar contexto).

Basándote ÚNICAMENTE en la transcripción proporcionada (nunca inventes datos, acuerdos, cifras o nombres que no aparezcan ahí), escribe exactamente esta estructura, en texto plano (sin markdown de encabezados, sin **negritas**):

1. Un primer párrafo de 2-3 líneas que resuma el propósito y el tono general de la reunión, de forma cordial y positiva.
2. Una lista de 3 a 6 puntos clave (temas tratados, decisiones o acuerdos importantes). Cada línea debe empezar con "- ".
3. Si en la transcripción se mencionaron próximos pasos o pendientes claros, agrega un bloque con el título exacto "Próximos pasos" seguido de líneas que empiecen con "- ". Si no hay próximos pasos claros en la transcripción, omite por completo esta sección.
4. Un cierre cordial de 1-2 líneas, cálido y breve.

No incluyas saludo inicial ("Hola..."), ni firma al final — eso se agrega aparte. No repitas el título de la reunión textualmente. Escribe en español neutro, natural, sin sonar robótico ni exagerado.`;

export async function generarResumen(
  env: Env,
  meta: { title: string; created_at: string; folder: string },
  transcript: string,
): Promise<string> {
  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS
    ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[... transcripción truncada por longitud ...]'
    : transcript;

  const userPrompt = `Título de la reunión: ${meta.title}\nFecha: ${meta.created_at}\n\nTranscripción:\n${truncated}`;

  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 1024,
    temperature: 0.5,
  }) as { response?: string };

  const text = (result.response ?? '').trim();
  if (!text) throw new Error('Workers AI devolvió una respuesta vacía');
  return text;
}
