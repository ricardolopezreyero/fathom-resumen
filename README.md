# Fathom Resumen — SuperLeads

Cloudflare Worker que, cada vez que llega una reunión **nueva en vivo** a
[fanthom-superleads](https://github.com/ricardolopezreyero/fanthom-superleads),
genera un resumen con IA y envía un correo de seguimiento a los invitados —
desde la cuenta real de quien tuvo la llamada, con el tono que de verdad tuvo
la conversación.

Producción: **https://resumen.fathom.superleads.mx**

## Cómo funciona (arquitectura)

```
Fathom (graba la llamada)
   │  webhook en tiempo real
   ▼
fanthom-superleads  (Worker "fathom", dominio fathom.superleads.mx)
   │  guarda transcripción en R2 + fila en D1 (fanthom-db)
   │  encola { folder, recording_id, r2_key, invitados, colaborador... }
   ▼
Cola Cloudflare "fanthom-resumen-trigger"
   ▼
fathom-resumen  (este repo, dominio resumen.fathom.superleads.mx)
   1. Lee la transcripción de R2 (bucket compartido fanthom-transcripciones)
   2. Guarda de calidad: descarta si no hay transcripción real o no hay
      destinatarios (evita gastar IA/correos en reuniones vacías o "solo yo")
   3. Genera el resumen con Workers AI, con un tono que refleja el de la
      llamada (positivo, neutral o serio — nunca forzado)
   4. Envía un correo por destinatario vía Resend, desde el correo real de
      quien originó la transcripción
   5. Guarda todo en D1 propio (fathom-resumen-db), idempotente por
      recording_id
```

**Solo se dispara con el webhook en vivo**, no con los syncs masivos de
backfill de fanthom-superleads — así no se mandan correos de historial al
conectar un colaborador nuevo.

## El motor de redacción (tono adaptativo)

El prompt vive en [`src/summarize.ts`](src/summarize.ts) y usa
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Workers AI, contexto de 24K
tokens). Reglas centrales, pensadas para durar años sin sonar artificial:

- **El tono lo decide la transcripción, no una plantilla fija.** Si la llamada
  fue buena, el correo es cálido. Si fue rutinaria, es neutral y directo. Si
  hubo un problema o una queja real, el correo lo reconoce con seriedad y
  empatía — nunca finge satisfacción que la conversación no respalda.
- **Nunca inventa nada.** Solo usa lo que aparece literalmente en la
  transcripción — sin acuerdos, cifras o resultados fabricados.
- **No es un correo de ventas.** Evita frases publicitarias y casi nunca
  menciona "SuperLeads" — el objetivo es que se sienta como seguimiento
  genuino de la persona que tuvo la llamada, no una promoción.

Si el tono o el formato no queda bien en algún caso, el lugar correcto para
ajustarlo es el `SYSTEM_PROMPT` de `src/summarize.ts` — no hace falta tocar
nada más.

## El remitente ("De") siempre es el origen de la transcripción

Cada colaborador conectado en fanthom-superleads tiene su propio correo
registrado (columna `email` en la tabla `colaboradores`). Cuando llega una
reunión suya:

1. Se usa el **correo del colaborador registrado** como remitente (`De`) y
   `Reply-To` — ésta es la fuente de verdad.
2. Si no está registrado, se usa el `recorded_by` que reporta Fathom para
   esa llamada específica (menos confiable, pero mejor que nada).
3. Si tampoco hay eso, se usa `Ricardo@SuperLeads.mx` como último respaldo.

Esto significa que si mañana se conecta un tercer, cuarto o décimo
colaborador, sus resúmenes salen automáticamente desde su propio correo —
nadie tiene que tocar código para eso. Ver `resolverOrigen()` en
[`src/queue-handler.ts`](src/queue-handler.ts).

El dominio `superleads.mx` está verificado (SPF/DKIM) en la cuenta de Resend
usada, así que el envío es un correo genuino desde `nombre@superleads.mx`,
no un remitente técnico ni un truco de Reply-To.

## Prerrequisitos

- Cuenta de Cloudflare con Workers, D1, R2, Queues y Workers AI habilitados
  (todo dentro del plan gratuito/estándar).
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) autenticado
  contra esa cuenta (`wrangler login` o `wrangler whoami` para confirmar).
- Cuenta de [Resend](https://resend.com) con el dominio de envío verificado
  (hoy: `superleads.mx`) y una API key.
- Node.js 18+.

## Recursos de Cloudflare que usa este Worker

| Recurso | Nombre | Dónde vive |
|---|---|---|
| D1 (propio) | `fathom-resumen-db` | este repo — resúmenes, estados, logs |
| D1 (solo lectura) | `fanthom-db` | repo `fanthom-superleads` — para reconstruir/reintentar |
| R2 (compartido) | `fanthom-transcripciones` | repo `fanthom-superleads` — transcripciones en texto |
| Queue (consumidor) | `fanthom-resumen-trigger` | producida por `fanthom-superleads` |
| Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | incluido en la cuenta, sin key extra |

Todos estos IDs ya están en [`wrangler.toml`](wrangler.toml). Si se
recrea el proyecto desde cero en otra cuenta de Cloudflare, hay que:

```bash
wrangler d1 create fathom-resumen-db          # y actualizar database_id en wrangler.toml
wrangler queues create fanthom-resumen-trigger
```

(La R2 bucket y el D1 `fanthom-db` deben existir ya del lado de
`fanthom-superleads` — ver ese repo.)

## Instalación y deploy

```bash
npm install
wrangler d1 migrations apply fathom-resumen-db --remote   # aplica migrations/
wrangler secret put RESEND_API_KEY                         # pega la API key cuando la pida
wrangler deploy
```

No hay más secrets — todo lo demás son bindings normales en `wrangler.toml`.

## Cómo conectar un colaborador nuevo

Esto se hace del lado de **fanthom-superleads** (`fathom.superleads.mx`), no
aquí:

1. Entra a `fathom.superleads.mx` y llena el formulario "Agregar
   colaborador": nombre, **correo** (nuevo campo — es el remitente de sus
   resúmenes automáticos), API Key de Fathom y Webhook Secret.
2. Pega la Webhook URL que te muestra (`fathom.superleads.mx/webhook/<folder>`)
   en Fathom → Settings → Integrations → Webhooks.
3. Listo — sus reuniones nuevas dispararán resúmenes automáticamente,
   firmados con su propio correo.

Si un colaborador ya existía antes de este campo, en su tarjeta aparece un
aviso "Sin correo registrado" con un botón **Agregar** para completarlo sin
tener que borrarlo y volver a crearlo.

## Operación y monitoreo

- **Dashboard:** `https://resumen.fathom.superleads.mx/` — lista los últimos
  resúmenes con su estado, origen (De) y destinatarios, más los logs
  recientes. Se refresca solo cada 15s.
- **`GET /resumenes?limit=100`** — mismos datos en JSON.
- **`GET /logs?lines=120`** — logs recientes en texto plano.
- **`POST /probar`** — dispara el flujo completo con un `ResumenTriggerMessage`
  armado a mano en el body (útil para probar cambios sin esperar un webhook
  real). Ver forma del mensaje en `src/types.ts`.
- **`POST /reintentar/:folder/:recording_id`** — reconstruye el disparo desde
  `fanthom-db` (ya no depende del mensaje original de la cola, que se pierde
  una vez procesado) y reprocesa. Si ya se había enviado con éxito, pide
  `?force=1` para evitar duplicar correos a un cliente real por accidente.

### Estados de un resumen (columna `status` en `resumenes`)

| Estado | Qué significa |
|---|---|
| `pendiente` | En proceso — si se queda así mucho tiempo, revisar logs |
| `enviado` | Al menos un destinatario recibió el correo |
| `sin_destinatarios` | No había ningún invitado con correo válido (excluyendo al propio origen) |
| `sin_contenido` | La transcripción estaba vacía o era demasiado corta para resumir |
| `error` | Había destinatarios pero Resend falló para todos — dispara una alerta a `Ricardo@SuperLeads.mx` automáticamente |

### Alertas

Si un resumen termina en `error` (había a quién escribirle pero el envío
falló para todos), el Worker manda automáticamente un correo de alerta a
`Ricardo@SuperLeads.mx` con el motivo y el link directo para reintentarlo —
para que un fallo de Resend no pase inadvertido durante meses.

### Reintentos y resiliencia ya incorporados

- **Reintentos de red en Resend:** hasta 3 intentos con backoff si Resend
  responde 429 (rate limit) o 5xx.
- **Idempotencia:** cada reunión se procesa una sola vez (`recording_id` es
  clave primaria en `resumenes`); reintentos de la cola de Cloudflare no
  duplican correos.
- **Fallo antes de enviar = reintento automático de la cola:** si falla la
  lectura de R2 o la llamada a Workers AI (nada se envió aún), el mensaje se
  reintenta hasta 3 veces automáticamente.
- **Fallo después de enviar parcialmente = no se reintenta solo:** si el
  correo ya salió para alguien, un error posterior no relanza el mensaje
  completo (evitaría duplicar los correos que sí llegaron) — en su lugar
  queda registrado como `error` y dispara la alerta de arriba.

## Limitación conocida

Antes de que se verificara `superleads.mx` en Resend, los correos salían de
un dominio placeholder (`videoroom.live`) con Reply-To manual. Ya no aplica —
`superleads.mx` está verificado (sending habilitado) y el remitente es
siempre el correo real del origen. Si en el futuro se cambia de cuenta de
Resend, solo hay que volver a verificar el dominio ahí; no hay que tocar
código.

## Estructura del repo

```
src/
  types.ts          Env, mensajes de la cola, tipos de D1
  db.ts             D1: resumenes, logs, reconstruirTrigger (para /reintentar)
  summarize.ts       Prompt y llamada a Workers AI — el motor de redacción
  email.ts           Plantilla HTML/texto, envío por Resend, alerta admin
  queue-handler.ts    Orquesta todo: origen, guardas de calidad, envío
  index.ts           Rutas HTTP + consumidor de la cola
migrations/          Esquema D1, en orden
public/index.html     Dashboard
```
