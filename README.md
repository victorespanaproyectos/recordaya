# RecordaYa

Recordatorios de turnos por WhatsApp para negocios: envío automático 24 h y 2 h antes de cada turno, seguimiento de entregas y lecturas, y respuestas de los clientes, usando la **WhatsApp Cloud API** oficial de Meta.

> 🚧 En desarrollo — proyecto de portfolio.

## Stack

- **Next.js 16** (App Router) + **TypeScript**
- **Supabase** (PostgreSQL)
- **WhatsApp Cloud API** (Graph API v26.0) con plantillas aprobadas
- **Upstash QStash** (envíos programados)
- Próximamente: Tailwind + shadcn/ui (panel), Vercel (deploy)

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

En Supabase → **SQL Editor**, pega y ejecuta en orden los archivos de `supabase/migrations/` (`0001_init.sql`, `0002_reminders.sql`).

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
  -Headers $headers -ContentType "application/json" -Body $body
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

### 6. Turnos y recordatorios programados

1. En [Upstash Console](https://console.upstash.com) → **QStash**, copia el token y las dos signing keys a `.env.local`, y pon en `APP_URL` la URL pública (el túnel en desarrollo).
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
     -Headers $headers -ContentType "application/json" -Body $body
   ```

   Responde con el turno, los recordatorios programados y el resultado de la confirmación (`"notify": false` para no enviarla).

4. Cancelar o reprogramar:

   ```powershell
   Invoke-RestMethod -Method Patch -Uri http://localhost:3000/api/appointments/UUID_DEL_TURNO `
     -Headers $headers -ContentType "application/json" -Body '{"status":"cancelled"}'
   # o: -Body '{"starts_at":"2026-11-18T10:00:00-03:00"}'
   ```

5. (Opcional) En QStash → **Schedules**, crea uno con destino `APP_URL/api/jobs/dispatch` y cron `0 * * * *`.

## Roadmap

- [x] Envío de plantillas por Cloud API
- [x] Webhook con verificación de firma y estados de mensajes
- [x] Esquema de base de datos
- [x] Programación de recordatorios 24 h / 2 h (QStash)
- [ ] Confirmar / reprogramar / cancelar desde la respuesta del cliente
- [ ] Panel web: calendario, clientes, historial y métricas
- [ ] Login multi-negocio
- [ ] Deploy en Vercel + demo
