# 01 · Estado actual y auditoría técnica

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

Auditoría realizada sobre `main` @ `f1ad32b` (12 commits). Todo lo marcado **[HECHO]** se verificó leyendo el código. No se consultó la base de datos en vivo, ni el panel de Meta, ni Vercel, ni Upstash.

---

## 2. Estado actual de RecordaYa

### 2.1 Qué hace hoy

1. Se crea un turno (panel o `POST /api/appointments`): se hace *upsert* del cliente, se inserta el turno, se crean dos filas `messages` con `status='queued'` (`reminder_24h`, `reminder_2h`) y se programan en QStash; opcionalmente se envía la plantilla de confirmación. — `src/lib/appointments/service.ts:941`
2. QStash llama a `/api/jobs/send-reminder` a la hora indicada; si el turno sigue activo se envía la plantilla (la de "confirmado" si el cliente ya confirmó). — `src/lib/appointments/reminders.ts:657`
3. Un cron opcional de QStash llama a `/api/jobs/dispatch` cada hora para programar recordatorios más lejanos que la demora máxima del plan. — `src/app/api/jobs/dispatch/route.ts`
4. Meta envía al webhook estados (`sent/delivered/read/failed`) y mensajes entrantes. Los estados actualizan `messages`; cada mensaje entrante se guarda en `inbound_messages` y se pasa **siempre** a `handleCustomerReply`. — `src/lib/whatsapp/process-webhook.ts:212`
5. `handleCustomerReply` interpreta «1/2» (y sinónimos por primera palabra), busca el turno (por mensaje citado o próximo turno activo del teléfono) y confirma, cancela o, si la intención es desconocida y hay turno activo, **responde con el recordatorio de opciones 1/2**. Si el teléfono no tiene turno, no responde. — `src/lib/appointments/replies.ts:813`
6. Panel (`/panel`): agenda (próximos, pasados, cancelados), métricas, actividad reciente, alta de turnos, detalle con línea de tiempo de mensajes y acciones.

### 2.2 Stack real vs. stack declarado en el encargo

| Tecnología declarada | ¿Presente? | Evidencia |
| --- | --- | --- |
| Next.js (App Router) | **Sí, 16.4.6**, con `cacheComponents: true` y `partialPrefetching: true` | `package.json`, `next.config.ts` |
| TypeScript | Sí (`strict: true`) | `tsconfig.json` |
| Tailwind CSS | Sí, v4 (`@tailwindcss/postcss`) | `package.json` |
| shadcn/ui | **No.** Componentes propios (`src/components/*`, `buttonStyles` en `src/lib/panel/ui.ts`) + `lucide-react` | — |
| Zod | **No.** Validación manual (`src/lib/http.ts`, `ServiceError`) | — |
| Supabase / PostgreSQL | Sí, `@supabase/supabase-js` con **clave secreta (service_role)** solo en servidor | `src/lib/supabase/admin.ts` |
| Supabase Auth | **No.** Login por contraseña compartida `PANEL_PASSWORD` + cookie HMAC propia | `src/app/login/actions.ts`, `src/lib/panel/session-token.ts` |
| Drizzle ORM | **No.** Consultas con el *query builder* de supabase-js; migraciones SQL a mano | `supabase/migrations/*.sql` |
| Meta WhatsApp Cloud API + webhooks | Sí, Graph API `v26.0` por defecto | `src/lib/whatsapp/*` |
| Vitest | **No.** No hay pruebas automatizadas | — |
| ESLint | Sí (`eslint-config-next` core-web-vitals + typescript) | `eslint.config.mjs` |
| Prettier | **No** | — |
| GitHub Actions | **No** (no existe `.github/`) | — |
| Vercel | Sí (según README: deploy automático en push a `main`) | `README.md` |
| — (no declarado) | **Upstash QStash** para envíos programados | `src/lib/scheduler/qstash.ts` |
| — (no declarado) | React 19.3, `server-only` | `package.json` |

**Consecuencia para el diseño [PROPUESTA]:** no se introduce Drizzle ni shadcn/ui (no aportan a la ampliación y duplicarían patrones existentes). Sí se introducen **Zod** (necesario para validar la salida estructurada de la IA y entradas nuevas), **Vitest** (necesario para regresión) y **GitHub Actions** (lint + typecheck + test). Supabase Auth se introduce por la necesidad de operadores identificados (D-01).

> Nota: `AGENTS.md` advierte que esta versión de Next.js tiene cambios incompatibles con versiones anteriores. Ejemplos ya presentes en el código: el *middleware* se llama `proxy` (`src/proxy.ts`), `RouteContext<"/api/…">` y `PageProps<"/panel">` tipados globalmente, `refresh()` de `next/cache` en Server Actions, `connection()` para marcar renderizado por petición. Antes de cada tarea de UI o rutas, leer la guía correspondiente en `node_modules/next/dist/docs/`.

---

## 3. Auditoría técnica

### 3.1 Estructura de directorios

```
src/
├── proxy.ts                         # Protege /panel/* (cookie ry_panel)
├── app/
│   ├── page.tsx                     # Landing pública
│   ├── layout.tsx, globals.css
│   ├── login/{page,login-form,actions}.tsx
│   ├── panel/
│   │   ├── layout.tsx               # Header con nav (solo "Agenda") y ToastProvider
│   │   ├── page.tsx                 # Agenda + métricas + actividad (Suspense)
│   │   ├── actions.ts               # Server Actions: crear, cambiar estado, reprogramar
│   │   ├── appointment-actions.tsx, new-appointment.tsx  # Client Components
│   │   └── turnos/[id]/page.tsx     # Detalle con línea de tiempo
│   ├── privacidad/, eliminacion-de-datos/   # Requeridos por Meta
│   └── api/
│       ├── appointments/route.ts, appointments/[id]/route.ts   # Bearer ADMIN_API_KEY
│       ├── jobs/send-reminder/route.ts      # Firma QStash
│       ├── jobs/dispatch/route.ts           # Firma QStash o Bearer
│       ├── messages/test/route.ts           # Bearer
│       └── webhooks/whatsapp/route.ts       # Firma X-Hub-Signature-256
├── components/   logo, message-ticks, modal, status-badge, toaster
└── lib/
    ├── env.ts, http.ts, dates.ts, legal.ts
    ├── auth/admin-key.ts
    ├── supabase/admin.ts
    ├── scheduler/qstash.ts
    ├── panel/{auth,data,session-token,ui}.ts
    ├── appointments/{intent,notify,reminders,replies,service}.ts
    └── whatsapp/{client,templates,webhook,process-webhook}.ts
scripts/ seed-demo.mjs, simulate-reply.mjs
supabase/migrations/ 0001_init … 0004_customer_replies
```

### 3.2 Patrones y convenciones existentes (a respetar)

| Aspecto | Patrón actual [HECHO] | Uso en la ampliación |
| --- | --- | --- |
| Capa de servicio | Casos de uso en `src/lib/<dominio>/service.ts`, compartidos por API y Server Actions; errores de negocio con `ServiceError(message, status)` | Igual: `src/lib/chatbot/**/service.ts`; reutilizar `ServiceError` |
| Acceso a datos del panel | DAL de solo lectura `src/lib/panel/data.ts` con `import "server-only"` | Nuevo DAL `src/lib/chatbot/panel-data.ts` |
| Server Actions | `"use server"`, `requirePanelSession()` al inicio, devuelven `ActionResult { ok, message, error, warning, id }`, llaman `refresh()` | Mismo contrato `ActionResult`; reemplazar `requirePanelSession()` por `requireMember(role)` |
| Rutas API | Route Handlers con helpers `badRequest`, `unauthorized`, `serverError` | Igual |
| Jobs | QStash `publishJSON` + verificación `Upstash-Signature`; 2xx = fin, 5xx = reintento | Igual para `chatbot-reply`, `knowledge-ingest`, `conversations-maintenance` |
| Env | `requireEnv()` lanza `ConfigError` con mensaje útil | Igual |
| Fechas | Siempre en zona del negocio (`dates.ts`, locale `es-UY`) | Reutilizar para horarios humanos |
| Teléfonos | Solo dígitos, formato internacional (`normalizePhone`) | Igual para `chat_contacts.wa_id` |
| SQL | Tablas en plural `snake_case`, `uuid` + `gen_random_uuid()`, `timestamptz`, trigger `set_updated_at`, `enum` de Postgres, RLS activado | Igual |
| Idioma | Código en inglés, comentarios y mensajes al usuario en español | Igual |
| Estilos | Tokens CSS (`bg-surface`, `text-muted`, `bg-brand`…), `buttonStyles`, `inputStyles`, modo claro/oscuro | Reutilizar; sin nueva librería de UI |

### 3.3 Autenticación y autorización

- **[HECHO]** Panel: una sola contraseña (`PANEL_PASSWORD`), comparación en tiempo constante, demora fija de 400 ms, cookie `ry_panel` = `exp.HMAC(exp)` con `PANEL_SESSION_SECRET` (o `ADMIN_API_KEY`), 7 días, `httpOnly`, `sameSite=lax`. No hay identidad de usuario ni roles.
- **[HECHO]** `proxy.ts` hace chequeo optimista en `/panel/:path*`; cada página y Server Action vuelve a verificar con `requirePanelSession()`.
- **[HECHO]** API interna: `Authorization: Bearer ADMIN_API_KEY` con `timingSafeEqual`.
- **[HECHO]** No hay protección contra fuerza bruta más allá de la demora fija (sin bloqueo por IP).
- **Impacto**: la atención humana requiere saber **qué** operador toma y responde. Se propone Supabase Auth + tabla `business_members` (ver [06-apis-e-interfaz.md §Permisos](06-apis-e-interfaz.md#3-autenticación-y-permisos)).

### 3.4 Base de datos

**Tablas [HECHO]** (`0001`–`0004`):

| Tabla | Clave | FKs | Índices relevantes | Notas |
| --- | --- | --- | --- | --- |
| `businesses` | `id uuid` | — | — | `name`, `timezone` (def. `America/Montevideo`), `address` (0002) |
| `customers` | `id uuid` | `business_id → businesses` cascade | `unique(business_id, phone)` | `name not null` |
| `appointments` | `id uuid` | `business_id`, `customer_id` cascade | `(business_id, starts_at)` | `status appointment_status` |
| `messages` | `id uuid` | `business_id` (nullable), `appointment_id` set null | `wa_message_id unique`, `(appointment_id)`, `(status)`, único parcial `(appointment_id, kind) where status='queued'`, `(scheduled_for) where queued and schedule_id is null` | Salientes; `kind message_kind` incluye `reply` (0004) |
| `inbound_messages` | `id uuid` | `appointment_id` set null (0004) | `wa_message_id unique`, `(from_phone, received_at desc)`, `(appointment_id)` | **Sin `business_id`**; `intent` check `confirm/cancel/unknown` |
| `webhook_events` | `bigint identity` | — | — | Log crudo de todos los webhooks, **sin retención** |

**Enums [HECHO]**: `appointment_status`, `message_kind` (`reminder_24h, reminder_2h, confirmation, cancellation, reschedule, test, reply`), `message_status` (`queued, accepted, sent, delivered, read, failed, cancelled`).

**RLS [HECHO]**: activado en todas las tablas **sin políticas**; solo `service_role` accede (grants en `0003`, incluidos *default privileges* para tablas futuras).

**Migraciones [HECHO]**: SQL plano, numeradas, ejecutadas a mano en el SQL Editor (README). No hay scripts de reversión, ni tabla de control de versiones propia (si se usó `supabase db push`, existiría `supabase_migrations.schema_migrations` [PENDIENTE]). Dos proyectos: `recordaya-dev` y `RecordaYA` (producción).

**Extensiones**: no se usa ninguna explícitamente. `pgvector` [PENDIENTE] verificar disponibilidad en el proyecto (Supabase la ofrece; se habilita con `create extension vector`).

**Usuarios/roles**: no hay tablas de usuarios. `auth.users` existe en todo proyecto Supabase pero no se usa.

### 3.5 Integración con Meta

| Aspecto | Estado [HECHO] | Archivo |
| --- | --- | --- |
| Envío | `sendTemplate()` y `sendText()` a `POST /{version}/{phone_number_id}/messages` con token *Bearer* global | `whatsapp/client.ts` |
| Errores | `WhatsAppApiError(message, httpStatus, code, details)`; recordatorios: 4xx ⇒ `failed`, 5xx ⇒ excepción para que QStash reintente | `client.ts`, `reminders.ts:706` |
| Plantillas | 5 plantillas aprobadas, idioma `es`, variables posicionales | `whatsapp/templates.ts` |
| Webhook GET | Verificación con `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `api/webhooks/whatsapp/route.ts` |
| Webhook POST | Firma `X-Hub-Signature-256` (HMAC-SHA256 del cuerpo crudo, `WHATSAPP_APP_SECRET`), parseo, 200 inmediato, procesamiento en `after()` | idem |
| Procesamiento | Guarda payload crudo en `webhook_events`; recorre `entry[].changes[]` con `field === 'messages'`; aplica estados (con ranking para no retroceder) y guarda entrantes | `process-webhook.ts` |
| Idempotencia | `inbound_messages.wa_message_id unique` + `upsert … ignoreDuplicates`: si no se insertó, no se procesa | `process-webhook.ts:214` |
| Identificadores | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` (solo en README/curl), token permanente de usuario del sistema | `.env.example` |
| `metadata.phone_number_id` | Tipado pero **no usado** (no se distingue número receptor) | `webhook.ts:387` |
| `contacts[].profile.name` | Tipado pero **no usado** | `webhook.ts:388` |
| Mensaje citado | `message.context.id` se usa para asociar la respuesta al turno | `replies.ts:781` |
| Tipos no texto | Se guardan con `body = null`; `parseReplyIntent(null) = unknown` | `webhook.ts:399` |
| Suscripción | Campo `messages` del webhook; app publicada; WABA suscrita vía `subscribed_apps` (README) | [PENDIENTE] verificar en Meta |
| Ventana de 24 h | Comentada en `sendText()`; no se controla en código | `client.ts:77` |
| Errores en `after()` | Se registran con `console.error` y se pierden (Meta ya recibió 200; no hay reintento) | `route.ts:1293` |

### 3.6 Puntos de integración identificados para el chatbot

| Punto | Tipo de cambio | Justificación |
| --- | --- | --- |
| `process-webhook.ts → saveIncoming()` | **Modificar (1 llamada)**: reemplazar la llamada directa a `handleCustomerReply` por `routeInboundMessage()` | Único punto por donde entran mensajes; el router delega en `handleCustomerReply` sin cambiarlo |
| `process-webhook.ts → applyStatus()` | **Modificar**: si el `wamid` no está en `messages`, buscar en `conversation_messages` | Hoy retorna sin hacer nada (`:194`); los mensajes del bot/operadores necesitan estados ✓✓ |
| `process-webhook.ts → processWebhook()` | **Modificar**: pasar `change.value.metadata` y `contacts` a `saveIncoming` | Resolver negocio y nombre de perfil |
| `whatsapp/webhook.ts` | **Ampliar tipos** (sin cambiar `verifyWebhookSignature` ni `incomingText`) | Leer `interactive.button_reply.id`, `profile.name` |
| `whatsapp/client.ts` | **Agregar** `sendInteractiveButtons()`; `postMessage` se exporta o se reutiliza internamente | Botones de confirmación de derivación |
| `scheduler/qstash.ts` | **Agregar** `publishJob(path, body, opts)`; `scheduleReminder` no cambia | Jobs nuevos |
| `panel/layout.tsx` | **Modificar**: nav con nuevas secciones según rol | UI integrada |
| `proxy.ts`, `panel/auth.ts`, `login/*` | **Modificar** (Fase 3) | Supabase Auth + compatibilidad con cookie actual |
| `panel/data.ts` | **Modificar** (Fase 10): filtrar por `business_id` de la sesión | Hoy lista turnos de **todos** los negocios y usa `businesses[0]` como zona; necesario para aislamiento (D-01) |
| `appointments/replies.ts`, `intent.ts`, `reminders.ts`, `notify.ts`, `service.ts` | **Sin cambios** (se agrega `parseStrictReplyIntent` en un archivo nuevo) | Preservar recordatorios |

### 3.7 Componentes reutilizables (no duplicar)

- `getSupabaseAdmin()`, `requireEnv()`, `ConfigError`, `getAppUrl()`.
- `sendText()`, `normalizePhone()`, `WhatsAppApiError`, `verifyWebhookSignature()`, `incomingText()`.
- `verifyQStashSignature()`, cliente QStash (modo dev incluido).
- `dates.ts` (`formatFecha`, `formatHora`, `zonedToUtc`, `dayKey`, `timeAgo`, `relativeDayLabel`).
- `http.ts` helpers, `ServiceError`.
- `loadAppointment()` para inyectar el próximo turno del cliente en el contexto de la IA.
- UI: `Modal`, `Toaster`, `StatusBadge`, `MessageTicks`, `Logo`, `buttonStyles`, `inputStyles`, `cn`, `formatPhone`, `initials`.
- `handleCustomerReply()` se reutiliza **tal cual** desde el router.
- Tabla `inbound_messages` como registro crudo de entrantes (no se crea otra tabla de entrantes crudos).
- Enum `message_status` para estados de los mensajes salientes del chatbot.

### 3.8 Riesgos de integración detectados

| ID | Riesgo | Evidencia | Mitigación |
| --- | --- | --- | --- |
| RI-01 | Hoy **todo** texto libre de un cliente con turno activo recibe «Responde 1 o 2». Con chatbot activo esto chocaría con la respuesta de la IA (dos respuestas) | `replies.ts:853` | El router decide antes; en modo chatbot no se llama a `handleCustomerReply` para texto que no es respuesta a recordatorio |
| RI-02 | `parseReplyIntent` toma la **primera palabra**: «No sé si abren el sábado» ⇒ `cancel` ⇒ **cancela el turno** | `intent.ts:425` | Con chatbot activo, parser estricto fuera de respuestas citadas (D-06). Con chatbot inactivo, sin cambios |
| RI-03 | `findAppointmentId` busca por teléfono en **todos** los negocios | `replies.ts:790` | Fuera de alcance modificar; documentado. El router resuelve el negocio antes y el chatbot filtra por `business_id` |
| RI-04 | `inbound_messages` no tiene `business_id` | `0001_init.sql:295` | La relación negocio↔mensaje vive en `conversation_messages`; no se altera `inbound_messages` salvo una columna nullable opcional (no requerida) |
| RI-05 | `after()` en el webhook: si una llamada a IA tarda, puede superar la duración máxima de la función; los errores se pierden | `route.ts:1293` | La IA corre en un job QStash con reintentos, no en `after()` |
| RI-06 | El panel no filtra por negocio | `panel/data.ts:584` | Tarea específica con pruebas de regresión (T-10.1) |
| RI-07 | `webhook_events` crece sin límite y contiene datos personales | `0001_init.sql:310` | Job de mantenimiento con retención (T-12.6) |
| RI-08 | Sin pruebas automatizadas: cualquier cambio en el webhook es riesgoso | — | Fase 1 crea pruebas de caracterización **antes** de tocar código |
| RI-09 | El cupo diario de QStash del plan gratuito se compartiría con los jobs del chatbot | `.env.example` (plan Free) | Medir; ver §24 y riesgo RK-06 |
| RI-10 | Se usa un único webhook para dev y prod (Meta solo admite uno): las pruebas reales del chatbot solo ocurren en producción | README "Entornos" | Extender `scripts/simulate-reply.mjs` y usar la zona de pruebas del panel |
| RI-11 | `cacheComponents: true`: las páginas nuevas deben usar `connection()`/Suspense igual que las actuales o fallará el prerender | `panel/auth.ts:516` | Seguir el patrón `hasPanelSession()` |

### 3.9 Información no verificable desde el repositorio

| Necesito | Para decidir / ejecutar |
| --- | --- |
| Confirmar que el webhook de Meta está suscrito solo al campo `messages` y la versión de API configurada en la app | Integración T-08.x |
| Calidad del número y límite de mensajería (tier) en WhatsApp Manager | Límites de throughput (§17) |
| Si la WABA tiene método de pago y en qué país se factura | Costos de plantillas (§24) |
| Plan de Upstash QStash (cupo diario, demora máxima) en producción | Riesgo RI-09 |
| Plan de Vercel (Hobby/Pro) y duración máxima de funciones configurada | `maxDuration` de jobs, D-09 |
| Plan de Supabase de cada proyecto (Free/Pro), tamaño actual de la base y del Storage | Capacidad de vectores, pausas por inactividad del plan Free |
| Si `pgvector` puede habilitarse en ambos proyectos | Fase 3 |
| Cuántos negocios existen en producción y si se espera más de uno | D-01 |
| Si las migraciones se aplicaron con el SQL Editor o con la CLI (`supabase_migrations`) | Procedimiento de migración (§23) |
| Si existe un dominio propio y una política de privacidad que deba ampliarse por uso de IA | Legal (§19) |
