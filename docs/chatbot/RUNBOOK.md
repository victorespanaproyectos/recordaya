# Runbook del chatbot (operación)

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

Borrador de T-14.1/T-14.2. Todo lo que dice «sin verificar» no se ha probado con WhatsApp, Gemini, Voyage ni QStash reales.

## 1. Activar y desactivar

Hay tres niveles; el más restrictivo manda.

| Nivel | Cómo | Efecto |
| --- | --- | --- |
| Global (kill switch) | `CHATBOT_ENABLED=false` en Vercel y redeploy | Ningún negocio usa el chatbot; todo sigue por la ruta de recordatorios de siempre |
| Piloto | `CHATBOT_ALLOWLIST_PHONES=598…,598…` | Solo esos teléfonos pasan por el chatbot; el resto, ruta anterior |
| Por negocio | `/panel/chatbot` → interruptor de activación (admin) | Solo ese negocio |

Para que un negocio reciba mensajes, `businesses.wa_phone_number_id` debe ser igual al `WHATSAPP_PHONE_NUMBER_ID` del número que usa. Si el chatbot se apaga con conversaciones abiertas, los mensajes del cliente se siguen guardando para el operador y el job de respuesta se omite.

## 2. Rotar claves

| Clave | Pasos |
| --- | --- |
| `GEMINI_API_KEY`, `VOYAGE_API_KEY` | Crear la nueva en la consola del proveedor → actualizar en Vercel (Production y Preview) → redeploy → revocar la anterior |
| `CHATBOT_PROMPT_CANARY` | Cambiar el valor y redeploy. No requiere migración |
| `AUDIT_IP_SALT` | Cambiarla impide comparar hashes de IP anteriores con los nuevos; el límite de login se reinicia |
| `ADMIN_API_KEY`, `PANEL_SESSION_SECRET` | Cambiar y redeploy; `PANEL_SESSION_SECRET` cierra todas las sesiones del login con contraseña compartida |

Cambiar de proveedor de embeddings o de dimensión obliga a re-embeber todas las fuentes y, si cambia la dimensión, a alterar `vector(n)` en la base (ver `04-motor-ia-y-rag.md`).

## 3. Reprocesar conocimiento

En `/panel/conocimiento`, abrir la fuente → **Reintentar**. Crea una nueva versión pendiente y encola `/api/jobs/knowledge-ingest`; la versión anterior sigue respondiendo hasta que la nueva quede lista. Una fuente en `failed` muestra el motivo.

## 4. Presupuesto

- Tope mensual por negocio: `/panel/chatbot` (owner) o `CHATBOT_DEFAULT_MONTHLY_BUDGET_USD`. Tope diario global: `CHATBOT_GLOBAL_DAILY_BUDGET_USD`.
- Al 80 % hay banner en `/panel/chatbot/metricas` (admin y owner); al 100 % el chatbot pasa a «solo derivación» (evento `budget_exhausted`).
- El costo en USD del panel es una estimación a precio de lista, no la factura. Con la capa gratuita se vigila el cupo en las consolas de Google y Voyage.

## 5. Mantenimiento programado

Schedule de QStash cada 10 minutos hacia `POST /api/jobs/conversations-maintenance` (o disparo manual con `Authorization: Bearer $ADMIN_API_KEY`). Responde `{resolved, closed, requeued, unavailable, purged}`. Si deja de correr: no se cierran conversaciones por inactividad, los operadores ausentes siguen «disponibles», los mensajes sin respuesta no se re-encolan y no se aplica la retención.

## 6. Retención y borrado

- Automática (mantenimiento): `webhook_events` 30 días; `conversations` y `unanswered_questions` 12 meses; `login_attempts` 1 día.
- Por contacto: owner → detalle de la conversación → **Borrar datos de este contacto**. Queda `contact.erased` en `audit_log` (id del contacto y conteos, sin teléfono).
- Solicitudes por correo (`/eliminacion-de-datos`): ubicar al contacto en la bandeja por su teléfono y borrarlo con la acción anterior; los datos de agenda (`customers`, turnos, recordatorios) se borran aparte.

## 7. Revertir

1. Rápido: `CHATBOT_ENABLED=false` (sección 1).
2. De esquema: respaldo previo obligatorio. Aplicar `supabase/migrations/down/0012.sql` … `0005.sql` en orden descendente. Probado `up → down → up` solo en `recordaya-dev` para 0005–0011; la reversión 0012 se escribió pero no se ejecutó.

## 8. Consultas de monitoreo (SQL Editor)

```sql
-- Conversaciones por estado
select status, count(*) from conversations group by status order by 2 desc;

-- Cola de atención humana: las más antiguas primero
select id, business_id, handoff_reason, last_message_at
from conversations where status = 'pending_human' order by last_message_at limit 20;

-- Mensajes salientes fallidos en las últimas 24 h
select business_id, count(*) from conversation_messages
where direction = 'outbound' and status = 'failed' and created_at > now() - interval '24 hours'
group by business_id;

-- Consumo de IA por día (estimado a precio de lista)
select date_trunc('day', created_at) as dia, operation, count(*) as llamadas, sum(cost_usd) as usd,
       count(*) filter (where status <> 'ok') as con_error
from chatbot_usage where created_at > now() - interval '14 days' group by 1, 2 order by 1 desc;

-- Preguntas sin respuesta abiertas por negocio
select business_id, count(*) from unanswered_questions where status = 'open' group by business_id;

-- Turnos del chatbot omitidos por límite de mensajes (últimos 7 días)
select business_id, count(*) from conversation_events
where type = 'rate_limited' and created_at > now() - interval '7 days' group by business_id;

-- Intentos de login bloqueados (IP con hash, últimos 15 min)
select ip_hash, count(*) from login_attempts where attempted_at > now() - interval '15 minutes'
group by ip_hash having count(*) >= 10;
```

No hay alertas automáticas configuradas: la revisión es manual (diaria durante el piloto).

## 9. Puesta en producción (Fase 13)

Orden recomendado. «Tú» = acciones que solo puede hacer el responsable (cuentas, claves, consolas). Nada de esto se ha ejecutado todavía.

### 9.1 Base de datos (T-13.1)
1. **Tú:** respaldo del proyecto Supabase `RecordaYA` (Database → Backups).
2. **Tú:** SQL Editor → ejecutar `supabase/apply/prod-00-snapshot.sql` y guardar el resultado.
3. **Tú:** ejecutar `supabase/apply/prod-0005-0012.sql` (una sola transacción: si falla, no queda nada a medias). Generado desde `supabase/migrations/`; las migraciones sueltas están probadas en `recordaya-dev`, el paquete completo con `begin/commit` no se ha ejecutado como tal.
4. **Tú:** ejecutar `supabase/apply/prod-99-verify.sql` (esperado: 15, 11, 9, 1, 1, 1) y repetir el snapshot: los conteos deben ser idénticos a los del paso 2.
5. **Tú:** enlazar el negocio con su número de WhatsApp: `update businesses set wa_phone_number_id = '<WHATSAPP_PHONE_NUMBER_ID>' where id = '<id del negocio>';`

### 9.2 Cuentas y variables (T-13.2)
1. **Tú:** crear las claves de Gemini y Voyage y fijar sus límites de gasto/uso en cada consola.
2. **Tú:** en Vercel (Production) cargar: `GEMINI_API_KEY`, `VOYAGE_API_KEY`, `CHATBOT_ALLOWED_MODELS`, `CHATBOT_DEFAULT_MODEL` (verificar el id de modelo gratuito vigente), `CHATBOT_PROMPT_CANARY`, `AUDIT_IP_SALT`, `WHATSAPP_REOPEN_TEMPLATE` (plantilla *utility* aprobada en WhatsApp Manager) y, si ya usas usuarios, `PANEL_LEGACY_LOGIN=false`. Dejar `CHATBOT_ENABLED=false`.
3. **Tú:** Supabase → Authentication: registro abierto deshabilitado, `Redirect URLs` con `https://<dominio>/auth/confirmar` y las plantillas de correo en español.
4. **Tú:** protección de la rama `main` en GitHub y verificar que el workflow de CI corre (nunca se ha ejecutado).
5. Verificar que el despliegue arranca sin errores de configuración.

### 9.3 Lanzamiento oscuro (T-13.3)
Desplegar con `CHATBOT_ENABLED=false` y correr la regresión de recordatorios (R-01…R-20) con números de prueba; observar 48 h sin incidentes. Con el chatbot apagado el comportamiento es el de antes.

### 9.4 Piloto (T-13.5)
1. **Tú:** crear en QStash un Schedule cada 10 minutos hacia `https://<dominio>/api/jobs/conversations-maintenance`.
2. Entrar con la contraseña compartida, invitar a las personas reales desde `/panel/equipo` (el primer usuario debería ser owner) y confirmar que pueden iniciar sesión.
3. Cargar la base de conocimiento del negocio y probarla en `/panel/chatbot/pruebas`.
4. Opcional: `CHATBOT_ALLOWLIST_PHONES` con los teléfonos del piloto.
5. `CHATBOT_ENABLED=true` en Vercel y activar el chatbot solo en el negocio piloto desde `/panel/chatbot`. Observar una semana con las consultas de la sección 8.

### 9.5 Antes de abrir a otros negocios
Checklist de `10-despliegue-costos-riesgos.md` §27, evaluación real (`npm run eval:chatbot`) dentro de umbrales y revisión legal de `/privacidad`.
