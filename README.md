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
   3. Genera el resumen con Workers AI, en el idioma real de la llamada y con
      un tono que la refleja (positivo, neutral o serio — nunca forzado)
   4. Si el tono es tenso/con una queja real, lo retiene para tu aprobación
      en vez de mandarlo solo — ver "Revisión humana" abajo
   5. Envía un correo por destinatario vía Resend, desde el correo real de
      quien originó la transcripción
   6. Guarda todo en D1 propio (fathom-resumen-db), idempotente por
      recording_id, y rastrea entregas/rebotes/quejas vía webhook de Resend
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
ajustarlo es `buildSystemPrompt()` en `src/summarize.ts` — no hace falta
tocar nada más.

### Idioma

El idioma del correo (hoy: español o inglés) se detecta con una **heurística
propia, sin IA** (`detectarIdioma()` en `src/summarize.ts`, cuenta palabras
funcionales típicas de cada idioma en la transcripción). Esto es intencional:
pedirle al modelo que "detecte y escriba en ese idioma" dentro de un prompt
redactado en español no es confiable — el modelo tiende a anclarse al idioma
del propio prompt del sistema y sigue respondiendo en español aunque declare
haber detectado inglés (lo comprobamos en pruebas reales). La solución es
decidir el idioma nosotros mismos y usar un prompt de sistema **completo y
nativo en ese idioma** (`buildSystemPrompt('es' | 'en')`), para que el modelo
nunca tenga que cambiar de idioma a mitad de instrucciones. Si se agrega un
tercer idioma, hay que sumar su lista de palabras funcionales y su propio
`buildSystemPrompt`.

### Revisión humana en llamadas tensas

El modelo también clasifica el tono en la misma llamada (línea `META: tono=`
al inicio de su respuesta). Si el tono es `tenso` (problema, queja o
desacuerdo real — no una llamada simplemente seria), el correo **no se manda
solo al cliente**: queda con status `en_revision`, se guarda el borrador
completo, y te llega un correo a `Ricardo@SuperLeads.mx` con el texto y un
link para aprobarlo (`POST /aprobar/:recording_id`, también funciona como
`GET` para que el link del correo sea un simple click). Solo se envía al
cliente cuando alguien lo aprueba explícitamente.

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
wrangler secret put RESEND_WEBHOOK_SECRET                  # signing secret del webhook (ver abajo)
wrangler deploy
```

### Webhook de Resend (entregas/rebotes/quejas)

Hay que crear el webhook una vez en la cuenta de Resend, apuntando a
`https://resumen.fathom.superleads.mx/webhooks/resend`, con los eventos
`email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`.
Se puede crear vía API (devuelve el `signing_secret` directo, que es el que
va en `RESEND_WEBHOOK_SECRET`):

```bash
curl -X POST https://api.resend.com/webhooks \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "endpoint": "https://resumen.fathom.superleads.mx/webhooks/resend",
    "events": ["email.delivered","email.bounced","email.complained","email.delivery_delayed"]
  }'
```

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
- **`POST|GET /aprobar/:recording_id`** — aprueba y envía un borrador retenido
  por tono tenso (ver arriba).
- **`GET /bloqueados`** / **`DELETE /bloqueados/:email`** — lista o desbloquea
  manualmente direcciones que rebotaron o se quejaron.

### Estados de un resumen (columna `status` en `resumenes`)

| Estado | Qué significa |
|---|---|
| `pendiente` | En proceso — si se queda así mucho tiempo, revisar logs |
| `enviado` | Al menos un destinatario recibió el correo |
| `en_revision` | Tono tenso detectado — retenido, esperando aprobación en `/aprobar/:recording_id` |
| `sin_destinatarios` | No había ningún invitado con correo válido (excluyendo al propio origen y a los bloqueados) |
| `sin_contenido` | La transcripción estaba vacía o era demasiado corta para resumir |
| `error` | Había destinatarios pero Resend falló para todos, o se agotaron los reintentos antes de poder generar el resumen — dispara una alerta a `Ricardo@SuperLeads.mx` automáticamente |

### Rebotes y quejas

El webhook de Resend (`POST /webhooks/resend`, firmado con Svix — ver
`src/resend-webhook.ts`) marca cada entrega en la tabla `envios`. Si un
correo rebota o se marca como spam, la dirección se agrega automáticamente a
`bloqueados` y deja de recibir resúmenes — así no se sigue insistiendo con
una dirección muerta ni se daña la reputación del dominio `superleads.mx`.
Se puede desbloquear manualmente desde el dashboard o `DELETE /bloqueados/:email`
si el rebote fue algo temporal ya resuelto.

### Alertas

Dos casos mandan un correo de alerta automático a `Ricardo@SuperLeads.mx`,
para que ningún fallo pase inadvertido durante meses:

1. **Envío fallido con destinatarios válidos** — Resend falló para todos,
   incluye el motivo y el link directo para reintentar.
2. **Se agotaron los reintentos automáticos** — si la lectura de R2 o la
   llamada a Workers AI falla 3 veces seguidas (ver `MAX_INTENTOS_COLA` en
   `src/queue-handler.ts`, debe coincidir con `max_retries` del consumer en
   `wrangler.toml`), Cloudflare descartaría el mensaje en silencio; en vez de
   eso el Worker deja constancia en D1 (`status: error`) y avisa antes de
   soltarlo.

### Reintentos y resiliencia ya incorporados

- **Reintentos de red en Resend:** hasta 3 intentos con backoff si Resend
  responde 429 (rate limit) o 5xx.
- **Idempotencia:** cada reunión se procesa una sola vez (`recording_id` es
  clave primaria en `resumenes`); reintentos de la cola de Cloudflare no
  duplican correos.
- **Fallo antes de enviar = reintento automático de la cola:** si falla la
  lectura de R2 o la llamada a Workers AI (nada se envió aún), el mensaje se
  reintenta hasta 3 veces automáticamente, y si se agotan sin éxito se avisa
  (ver "Alertas" arriba) en vez de descartarse en silencio.
- **Fallo después de enviar parcialmente = no se reintenta solo:** si el
  correo ya salió para alguien, un error posterior no relanza el mensaje
  completo (evitaría duplicar los correos que sí llegaron) — en su lugar
  queda registrado como `error` y dispara la alerta.
- **Direcciones muertas no reciben más intentos:** ver "Rebotes y quejas".

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
  types.ts            Env, mensajes de la cola, tipos de D1
  db.ts               D1: resumenes, logs, envios, bloqueados, reconstruirTrigger
  summarize.ts        Detección de idioma + prompts (es/en) + llamada a Workers AI
  email.ts            Plantillas HTML/texto bilingües, envío por Resend, alertas
  resend-webhook.ts   Verificación Svix + procesamiento de eventos de Resend
  queue-handler.ts    Orquesta todo: origen, guardas, retención por tono, envío
  index.ts            Rutas HTTP + consumidor de la cola
migrations/           Esquema D1, en orden
public/index.html     Dashboard
```
