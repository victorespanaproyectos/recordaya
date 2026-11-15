# RecordaYa

Recordatorios de turnos por WhatsApp para negocios: envío automático 24 h y 2 h antes de cada turno, seguimiento de entregas y lecturas, y respuestas de los clientes, usando la **WhatsApp Cloud API** oficial de Meta.

> 🚧 En desarrollo — proyecto de portfolio.

## Stack

- **Next.js 16** (App Router) + **TypeScript**
- **Supabase** (PostgreSQL)
- **WhatsApp Cloud API** (Graph API v26.0) con plantillas aprobadas
- Próximamente: Upstash QStash (envíos programados), Tailwind + shadcn/ui (panel), Vercel (deploy)

## Arquitectura

```
src/
├── app/api/
│   ├── messages/test/route.ts      # POST: envía un recordatorio de prueba
│   └── webhooks/whatsapp/route.ts  # GET: verificación · POST: estados y respuestas
└── lib/
    ├── env.ts                      # variables de entorno validadas
    ├── auth/admin-key.ts           # protección de endpoints internos
    ├── supabase/admin.ts           # cliente de Supabase (solo servidor)
    └── whatsapp/
        ├── client.ts               # sendTemplate() → Cloud API
        ├── templates.ts            # nombres y variables de plantillas
        ├── webhook.ts              # firma HMAC + tipos del payload
        └── process-webhook.ts      # actualiza estados y guarda respuestas
supabase/migrations/0001_init.sql   # esquema de la base de datos
```

**Flujo de un mensaje:** la app envía la plantilla → Meta devuelve un `wamid` → se guarda en `messages` → Meta notifica por webhook `sent → delivered → read` (o `failed`) → se actualiza el estado.

## Puesta en marcha

### 1. Variables de entorno

```bash
cp .env.example .env.local
```

Completa `.env.local` (ver comentarios en `.env.example`).

### 2. Base de datos

En Supabase → **SQL Editor**, pega y ejecuta `supabase/migrations/0001_init.sql`.

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

## Roadmap

- [x] Envío de plantillas por Cloud API
- [x] Webhook con verificación de firma y estados de mensajes
- [x] Esquema de base de datos
- [ ] Programación de recordatorios 24 h / 2 h (QStash)
- [ ] Confirmar / reprogramar / cancelar desde la respuesta del cliente
- [ ] Panel web: calendario, clientes, historial y métricas
- [ ] Login multi-negocio
- [ ] Deploy en Vercel + demo
