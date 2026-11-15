# RecordaYa

Recordatorios de turnos por WhatsApp para negocios: envío automático 24 h y 2 h antes de cada turno, seguimiento de entregas y lecturas, y respuestas de los clientes, usando la **WhatsApp Cloud API** oficial de Meta.

> 🚧 En desarrollo — proyecto de portfolio.

## Stack

- **Next.js 16** (App Router) + **TypeScript**
- **Supabase** (PostgreSQL)
- **WhatsApp Cloud API** (Graph API v26.0) con plantillas aprobadas
- **Upstash QStash** (envíos programados)
- **Vercel** (deploy) · producción: https://recordaya.vercel.app
- Próximamente: Tailwind + shadcn/ui (panel)

## Arquitectura

```
src/
├── app/api/
│   ├── appointments/route.ts       # POST: crea turno + programa recordatorios
│   ├── appointments/[id]/route.ts  # GET: turno + mensajes · PATCH: confirmar/cancelar/reprogramar
│   ├── jobs/send-reminder/route.ts # POST (QStash): envía un recordatorio a su hora
│   ├── jobs/dispatch/route.ts      # POST (QStash cron): programa los pendientes lejanos
│   ├── messages/test/route.ts      # POST: envía un recordatorio de prueba
│   └── webhooks/whatsapp/route.ts  # GET: verificación · POST: estados y respuestas
└── lib/
    ├── env.ts                      # variables de entorno validadas
    ├── dates.ts                    # formato de fecha/hora en la zona del negocio
    ├── http.ts                     # helpers de respuestas
    ├── auth/admin-key.ts           # protección de endpoints internos
    ├── supabase/admin.ts           # cliente de Supabase (solo servidor)
    ├── scheduler/qstash.ts         # programar / cancelar envíos + verificar firma
    ├── appointments/
    │   ├── reminders.ts            # plan 24 h / 2 h, cancelación y envío
    │   └── notify.ts               # avisos inmediatos (confirmación, cancelación)
    └── whatsapp/
        ├── client.ts               # sendTemplate() → Cloud API
        ├── templates.ts            # nombres y variables de plantillas
        ├── webhook.ts              # firma HMAC + tipos del payload
        └── process-webhook.ts      # actualiza estados y guarda respuestas
supabase/migrations/               # esquema de la base de datos (0001, 0002…)
```

**Flujo de un mensaje:** la app envía la plantilla → Meta devuelve un `wamid` → se guarda en `messages` → Meta notifica por webhook `sent → delivered → read` (o `failed`) → se actualiza el estado.

**Flujo de un recordatorio:** se crea el turno → se insertan los recordatorios `reminder_24h` y `reminder_2h` como `queued` → QStash los guarda con `notBefore` → a la hora indicada llama a `/api/jobs/send-reminder` (con firma) → si el turno sigue activo, se envía la plantilla (la de "confirmado" si el cliente ya confirmó). Cancelar o reprogramar el turno borra los envíos pendientes en QStash. Los recordatorios que caen más allá de la demora máxima del plan quedan sin programar hasta que `/api/jobs/dispatch` (cron horario) los agenda.

## Puesta en marcha

### 1. Variables de entorno

```bash
cp .env.example .env.local
```

Completa `.env.local` (ver comentarios en `.env.example`).

### 2. Base de datos

En Supabase → **SQL Editor**, pega y ejecuta en orden los archivos de `supabase/migrations/` (`0001_init.sql`, `0002_reminders.sql`, `0003_service_role_grants.sql`, `0004_customer_replies.sql`).

### 3. Ejecutar

```bash
npm install
npm run dev
```

### 4. Probar un envío

PowerShell:

```powershell
$headers = @{ Authorization = "Bearer TU_ADMIN_API_KEY" }
$body = @{
  to      = "59899123456"
  nombre  = "Victor"
  fecha   = "lunes 17 de noviembre"
  hora    = "15:30"
  negocio = "Barbería Centro"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/messages/test `
  -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body
```

### 5. Webhook (estados de entrega y respuestas)

Meta necesita una URL pública. En desarrollo usa un túnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

En **Meta for Developers → tu app → WhatsApp → Configuración → Webhook**:

- URL de devolución de llamada: `https://<tu-tunel>/api/webhooks/whatsapp`
- Token de verificación: el valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Suscribirse al campo **messages**

`WHATSAPP_APP_SECRET` (Meta for Developers → Configuración de la app → Básica → Clave secreta) es obligatorio: sin él, el webhook rechaza todos los eventos por firma inválida.

Con el webhook activo, el cliente puede responder al recordatorio:

| Respuesta | Efecto |
| --- | --- |
| `1`, `sí`, `confirmo`… | El turno pasa a `confirmed` y se le contesta confirmando. Los recordatorios siguientes usan la plantilla de "turno confirmado". |
| `2`, `no`, `cancelar`… | Se cancelan los recordatorios pendientes, el turno pasa a `cancelled` y se envía la plantilla de cancelación. |
| Otra cosa | Se le recuerda su próximo turno y las opciones 1 / 2. |

El turno se identifica por el mensaje citado (si responde a uno) o, si no, por su próximo turno activo.

### 6. Turnos y recordatorios programados

1. QStash:
   - **Desarrollo:** `QSTASH_DEV=true` y `APP_URL=http://localhost:3000`. El SDK arranca un QStash local, sin cuenta ni túnel.
   - **Producción:** en [Upstash Console](https://console.upstash.com) → **QStash**, copia el token y las dos signing keys, `QSTASH_DEV=false` y `APP_URL` con la URL pública.
2. Crea un negocio en Supabase (SQL Editor):

   ```sql
   insert into businesses (name, address) values ('Barbería Centro', 'Av. 18 de Julio 1234') returning id;
   ```

3. Crea un turno (PowerShell):

   ```powershell
   $headers = @{ Authorization = "Bearer TU_ADMIN_API_KEY" }
   $body = @{
     business_id = "UUID_DEL_NEGOCIO"
     customer    = @{ name = "Victor"; phone = "59899123456" }
     starts_at   = "2026-11-17T15:30:00-03:00"
     service     = "Corte de pelo"
   } | ConvertTo-Json

   Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/appointments `
     -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body
   ```

   Responde con el turno, los recordatorios programados y el resultado de la confirmación (`"notify": false` para no enviarla).

4. Cancelar o reprogramar:

   ```powershell
   Invoke-RestMethod -Method Patch -Uri http://localhost:3000/api/appointments/UUID_DEL_TURNO `
     -Headers $headers -ContentType "application/json; charset=utf-8" -Body '{"status":"cancelled"}'
   # o: -Body '{"starts_at":"2026-11-18T10:00:00-03:00"}'
   ```

5. (Opcional) En QStash → **Schedules**, crea uno con destino `APP_URL/api/jobs/dispatch` y cron `0 * * * *`.

## Deploy en Vercel

1. Importa el repo en Vercel (preset Next.js).
2. En **Environment Variables** pega las variables de `.env.example` con valores de producción (`QSTASH_DEV=false`, sin `APP_URL`: se toma la URL de producción de Vercel).
3. En **Integrations** agrega **Upstash QStash** (plan Free): crea `QSTASH_TOKEN`, `QSTASH_URL` y las dos signing keys automáticamente.
4. En Meta, cambia la URL del webhook a `https://<tu-proyecto>.vercel.app/api/webhooks/whatsapp` (hay que volver a escribir el token de verificación).

Cada push a `main` despliega automáticamente.

## Roadmap

- [x] Envío de plantillas por Cloud API
- [x] Webhook con verificación de firma y estados de mensajes
- [x] Esquema de base de datos
- [x] Programación de recordatorios 24 h / 2 h (QStash)
- [x] Confirmar / cancelar respondiendo 1 / 2
- [ ] Reprogramar desde WhatsApp
- [ ] Panel web: calendario, clientes, historial y métricas
- [ ] Login multi-negocio
- [x] Deploy en Vercel
- [ ] Publicar la app de Meta (eventos reales: entregado, leído, respuestas)
- [ ] Demo pública
