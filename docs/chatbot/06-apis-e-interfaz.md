# 06 · APIs, interfaz y permisos

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

Todo es **[PROPUESTA]**, siguiendo los patrones existentes [HECHO]: Server Actions para el panel (contrato `ActionResult`), Route Handlers para integraciones y jobs, helpers de `src/lib/http.ts`.

---

## 13. Diseño de APIs

### 13.1 Route Handlers nuevos

| Método y ruta | Autenticación | Propósito | Respuesta |
| --- | --- | --- | --- |
| `POST /api/jobs/chatbot-reply` | Firma QStash (`verifyQStashSignature`) | Ejecuta un turno de IA | `200 {outcome: "sent"\|"skipped"\|"handoff", reason?}` · `500` ⇒ QStash reintenta |
| `POST /api/jobs/knowledge-ingest` | Firma QStash | Procesa una versión de documento | `200 {outcome: "ready"\|"failed"\|"continued"}` |
| `POST /api/jobs/conversations-maintenance` | Firma QStash o `Bearer ADMIN_API_KEY` | Cierres por inactividad, disponibilidad, re-encolado de entrantes sin respuesta, purga por retención | `200 {resolved, closed, requeued, purged}` |
| `GET /api/panel/inbox?since=<iso>` | Sesión de miembro | Polling de la bandeja: conversaciones cambiadas desde `since` + contadores | `200 {conversations[], counts, serverTime}` |
| `GET /api/panel/conversations/[id]/messages?after=<id>` | Sesión de miembro del negocio | Polling del detalle | `200 {messages[], conversation}` |
| `GET /auth/callback` | Código de Supabase Auth | Intercambio de código (invitación, enlace mágico, recuperación) | Redirección a `/panel` |
| `POST /api/widget/v1/sessions` (F2) | Clave pública + origen | Abrir sesión anónima | `{token, conversationId}` |
| `POST /api/widget/v1/messages` (F2) | Token de sesión | Enviar mensaje | `202` |
| `GET /api/widget/v1/messages?after=` (F2) | Token de sesión | Recibir mensajes | `{messages[]}` |

Todos los handlers de jobs: `export const maxDuration = 60` (verificar límite del plan, D-09) y lectura del cuerpo crudo antes de verificar la firma (patrón de `send-reminder`).

#### Contrato del job `chatbot-reply`

```ts
// Encolado desde el router
await publishJob("/api/jobs/chatbot-reply",
  { conversationId, triggerMessageId },
  { delaySeconds: 2.5, deduplicationId: `chat-${waMessageId}`, retries: 3 });
```

```ts
// src/app/api/jobs/chatbot-reply/route.ts (esqueleto)
export const maxDuration = 60;
const Body = z.object({ conversationId: z.uuid(), triggerMessageId: z.uuid() });

export async function POST(request: Request) {
  const raw = await request.text();
  if (!(await verifyQStashSignature(request, raw))) return Response.json({ error: "Firma inválida" }, { status: 401 });
  const parsed = Body.safeParse(JSON.parse(raw));
  if (!parsed.success) return Response.json({ error: "Body inválido" }, { status: 400 });
  try {
    const result = await runChatbotTurn(parsed.data);
    return Response.json(result);
  } catch (error) {
    if (error instanceof PermanentError) return Response.json({ outcome: "failed", reason: error.message });
    log.error("jobs/chatbot-reply", error, parsed.data);
    return Response.json({ error: "Error temporal" }, { status: 500 });
  }
}
```

#### `GET /api/panel/inbox`

Parámetros: `since` (ISO), `status` (opcional, múltiple), `assigned=me|unassigned|all`, `q` (búsqueda), `channel`, `limit` (≤ 50), `cursor`.

```json
{
  "serverTime": "2026-11-19T15:42:10.000Z",
  "counts": { "pending_human": 2, "mine": 1, "unread": 3 },
  "conversations": [
    { "id": "…", "status": "pending_human", "channel": "whatsapp",
      "contact": { "name": "Lucía", "phone": "59899123456" },
      "lastMessage": { "preview": "¿Puedo pagar con…", "at": "…", "sender": "customer" },
      "assignedTo": null, "handoffReason": "no_information", "unread": 2, "windowExpiresAt": "…" }
  ]
}
```

Errores: `401` sin sesión, `403` sin membresía, `400` parámetros inválidos.

### 13.2 Server Actions nuevas

Todas: `"use server"`, primera línea `const member = await requireMember(<rol mínimo>)`, validación con Zod, `business_id` tomado de `member.businessId` (nunca del formulario), auditoría cuando corresponde, `refresh()` y `ActionResult`.

| Archivo | Acción | Rol mínimo | Efecto |
| --- | --- | --- | --- |
| `panel/chatbot/actions.ts` | `updateChatbotSettingsAction(form)` | admin (`llm_model`, `monthly_budget_usd`: owner) | Upsert de `chatbot_settings`; `audit_log` con diff |
| | `toggleChatbotAction(enabled)` | admin | Activa/desactiva; exige ≥ 1 fuente `ready` para activar |
| | `testChatbotAction(messages)` | admin | Zona de pruebas (dry run) |
| `panel/conocimiento/actions.ts` | `createFaqAction`, `createTextSourceAction`, `createUrlSourceAction` | admin | Crea fuente + versión 1 y encola ingesta |
| | `requestUploadAction({name, size, mime})` | admin | Valida, crea fuente/versión `pending`, devuelve `createSignedUploadUrl` (válida 2 h, ruta fija) |
| | `confirmUploadAction(sourceId)` | admin | Verifica que el objeto existe y su tamaño; encola ingesta |
| | `updateSourceAction(id, form)` | admin | Nueva versión (texto/FAQ) o metadatos (título/categoría sin re-procesar) |
| | `replaceFileAction(id, …)` | admin | Nueva versión de archivo (flujo de subida) |
| | `reprocessSourceAction(id)` | admin | Nueva versión con el mismo contenido (o relee la URL) |
| | `setSourceEnabledAction(id, enabled)` | admin | `disabled` ↔ `ready` |
| | `deleteSourceAction(id)` | admin | `deleted_at = now()`, borra fragmentos; purga física a 30 días; auditoría |
| `panel/conversaciones/actions.ts` | `claimConversationAction(id)` | operator | `claim_conversation()` |
| | `sendAgentMessageAction({conversationId, body, clientRequestId})` | operator asignado | Inserción condicionada + `sendText` |
| | `sendReopenTemplateAction(id)` | operator asignado | Plantilla D-08 |
| | `releaseConversationAction(id)` | asignado o admin | T6 |
| | `returnToBotAction(id, notify)` | asignado o admin | T7 |
| | `resolveConversationAction(id, notify)` | asignado o admin | T8 |
| | `closeConversationAction(id)` | admin (o asignado) | T12 |
| | `handoffConversationAction(id)` | operator | T3 |
| | `reassignConversationAction(id, memberId)` | admin | Reasignación |
| | `markReadAction(id)` | operator | `unread_count = 0` |
| | `resolveUnansweredAction(id, {sourceId?, ignore?})` | admin | Cierra pregunta |
| `panel/equipo/actions.ts` | `inviteMemberAction({email, name, role})` | admin (rol `owner` solo por owner) | Crea `business_members` `invited` + `auth.admin.inviteUserByEmail` |
| | `updateMemberAction(id, {role?, max_concurrent?, status?})` | admin/owner | Reglas: no degradar al último owner; desactivar libera conversaciones |
| | `setMyAvailabilityAction(available)` | operator | Propia disponibilidad |
| `login/actions.ts` (mod.) | `loginAction` | — | Email+contraseña con Supabase Auth; si `PANEL_LEGACY_LOGIN=true`, también la contraseña compartida actual |

Errores estándar: `ServiceError` (400/404/409) → `{ ok: false, error }`; inesperados → mensaje genérico (patrón `toResult` existente en `panel/actions.ts`).

### 13.3 Funciones de servicio (contratos internos)

```ts
// conversations/handoff.ts
offerHandoff(conv: Conversation, reason: HandoffReason): Promise<void>
acceptHandoff(conv: Conversation, by: "customer" | MemberRef): Promise<void>
claim(convId: string, member: Member): Promise<boolean>
release(convId: string, member: Member, version: number): Promise<void>
returnToBot(convId: string, member: Member, version: number, notify: boolean): Promise<void>
resolve(convId: string, member: Member, version: number, notify: boolean): Promise<void>

// rag/sources.ts
createSource(businessId, input: SourceInput, member): Promise<Source>
newVersion(sourceId, businessId, member, content?): Promise<DocumentVersion>
enqueueIngest(documentId): Promise<void>

// usage/budget.ts
assertBudget(businessId): Promise<{ ok: true } | { ok: false; reason: "budget_exhausted" }>
recordUsage(entry: UsageEntry): Promise<void>
```

### 13.4 Variables de entorno nuevas

Se agregan a `.env.example` (sin valores) y a Vercel.

```bash
# ── Chatbot ─────────────────────────────────────────────
# Interruptor global (false = ningún negocio usa el chatbot; ruta legacy para todos)
CHATBOT_ENABLED=false
# Opcional durante el piloto: solo estos teléfonos (coma) pasan por el chatbot; el resto, ruta legacy
CHATBOT_ALLOWLIST_PHONES=
# Proveedor de generación (Gemini, capa gratuita). Solo servidor.
GEMINI_API_KEY=
# Modelos que un negocio puede elegir (coma) y modelo por defecto (cuando llm_model = 'default').
# Los ids exactos de Gemini no están fijados en el código: se verifican en la documentación de Google.
CHATBOT_ALLOWED_MODELS=
CHATBOT_DEFAULT_MODEL=
# Embeddings
EMBEDDINGS_PROVIDER=voyage
VOYAGE_API_KEY=
EMBEDDINGS_MODEL=voyage-4-lite
EMBEDDINGS_DIMENSIONS=1024
# Límites
CHATBOT_DEFAULT_MONTHLY_BUDGET_USD=20
CHATBOT_GLOBAL_DAILY_BUDGET_USD=50
KNOWLEDGE_MAX_FILE_MB=10
# Token aleatorio para detectar fuga del prompt (genera uno largo)
CHATBOT_PROMPT_CANARY=
# Sal para hashear IPs en auditoría
AUDIT_IP_SALT=
# Plantilla aprobada para retomar conversación fuera de 24 h (vacío = deshabilitado)
WHATSAPP_REOPEN_TEMPLATE=

# ── Supabase Auth (panel con usuarios) ──────────────────
NEXT_PUBLIC_SUPABASE_URL=
# Clave publicable (sb_publishable_...). Segura en el navegador SOLO con RLS correcto; aquí solo la usa Auth.
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
# true = sigue aceptando PANEL_PASSWORD (modo demo/compatibilidad)
PANEL_LEGACY_LOGIN=true
```

Dependencias nuevas (`package.json`): `zod`, `@supabase/ssr`, `unpdf`, `mammoth`, `linkedom`, `@mozilla/readability`; Gemini y Voyage se llaman con `fetch` (REST), sin SDK; dev: `vitest`, `jszip`. Versiones exactas fijadas al implementar (`npm view <pkg> version`).

---

## 18. Diseño de interfaz

Se reutilizan layout, tokens y componentes actuales [HECHO]: `bg-surface`, `border-border`, `text-muted`, `bg-brand`, `buttonStyles`, `inputStyles`, `Modal`, `Toaster`, iconos `lucide-react`, animaciones `animate-rise`, modo claro/oscuro, `Suspense` + esqueletos.

### 18.1 Navegación (`panel/layout.tsx`)

```
[Logo]  Agenda · Conversaciones (3) · Conocimiento · Chatbot · Equipo      [● Disponible] [Negocio ▾] [Salir]
```

- Visibilidad por rol: operator ve Agenda y Conversaciones; admin/owner ven todo.
- Badge de Conversaciones = pendientes + no leídas asignadas (de `/api/panel/inbox`).
- Selector de negocio solo si el usuario pertenece a más de uno (cookie `ry_business`).
- La etiqueta "Modo demo" actual se muestra solo con sesión legacy.
- Móvil: la nav pasa a una barra inferior con 4 íconos (hoy la nav se oculta en `sm`).

### 18.2 Conversaciones — `/panel/conversaciones`

Diseño de dos columnas en escritorio (lista 360 px + detalle), una en móvil.

- Pestañas: **Pendientes** · **Mías** · **IA** · **Todas** · **Cerradas**.
- Búsqueda (nombre, teléfono, texto), filtros (canal, operador, rango de fechas).
- Fila: avatar con iniciales, nombre/teléfono, vista previa, hora relativa (`timeAgo`), chip de estado (colores consistentes con `APPOINTMENT_STATUS`: IA = sky, Pendiente = amber, Humano = emerald, Resuelta = slate, Cerrada = muted), motivo de derivación, contador de no leídos.
- Estados vacíos con texto guía ("No hay conversaciones esperando una persona 🎉").

### 18.3 Detalle — `/panel/conversaciones/[id]`

- Cabecera: contacto, estado, asignado, botones según estado/rol: **Tomar**, **Liberar**, **Devolver a la IA**, **Resolver**, **Cerrar**, **Reasignar** (admin).
- Banner de motivo: «Derivada porque el asistente no encontró información sobre *pago con transferencia*».
- Resumen (colapsable).
- Línea de tiempo con burbujas: cliente (izquierda), bot (derecha, ícono ✨ y enlace "fuentes"), agente (derecha, nombre), recordatorios (tarjeta compacta reutilizando `MessageTicks`), eventos del sistema (línea centrada gris).
- Compositor: solo habilitado si `status='human'` y asignado a mí; contador de ventana 24 h; atajos `Enter` enviar / `Shift+Enter` salto; botón plantilla si ventana vencida.
- Panel lateral: datos del cliente, próximo turno (enlace), preguntas sin respuesta de la conversación.
- Polling 3 s mientras la pestaña está visible (`document.visibilityState`).

### 18.4 Conocimiento — `/panel/conocimiento`

- Encabezado con botón **Agregar** (menú: Pregunta frecuente · Texto · Archivo · Página web).
- Tabla: tipo (ícono), título, categoría, estado (chip; `processing` con spinner; `failed` con tooltip del error y botón Reintentar), fragmentos, actualizado (`timeAgo` + autor), acciones (Editar, Desactivar, Eliminar con confirmación en `Modal`).
- Filtros por tipo/categoría/estado; búsqueda por título.
- Carga de archivo: zona de arrastre, validación de tipo y tamaño en cliente (y servidor), barra de progreso de subida, luego estado `processing` actualizado por polling cada 3 s.
- Detalle `/panel/conocimiento/[id]`: metadatos, historial de versiones, texto extraído (scroll), fragmentos numerados, botón "Probar una pregunta con esta fuente".
- Sección **Preguntas sin respuesta**: lista agrupada por similitud, botón "Crear FAQ con esta pregunta" (prellena el formulario) e "Ignorar".

### 18.5 Chatbot — `/panel/chatbot`

Pestañas:
1. **General**: interruptor (con validación), nombre, descripción, idioma.
2. **Personalidad**: tono (radio), personalidad, instrucciones (con contador de caracteres y ayuda "Estas instrucciones no pueden contradecir las reglas de seguridad").
3. **Mensajes**: cada mensaje con vista previa estilo burbuja de WhatsApp (reutilizar la vista previa del formulario de nuevo turno).
4. **Horario humano**: grilla semanal (días × franjas), excepciones por fecha, zona horaria del negocio (solo lectura).
5. **Comportamiento**: longitud, fallos antes de ofrecer humano, cierre por inactividad, umbral de confianza (avanzado), respuestas a recordatorios.
6. **IA y consumo** (owner): modelo (select con costo estimado por respuesta), esfuerzo, tope mensual, consumo del mes (barra).
7. **Probar**: chat de prueba con depuración (fragmentos, JSON, costo).

### 18.6 Métricas — `/panel/chatbot/metricas`

Tarjetas (mismo estilo que `Stats` actual): Conversaciones · Resueltas por IA (%) · Derivadas (%) · Pendientes ahora · Sin respuesta (abiertas) · 1.ª respuesta IA (mediana) · 1.ª respuesta humana (mediana) · Costo del mes (USD) / tope. Gráfico de barras diario (conversaciones IA vs derivadas) y tabla de consumo por operación/modelo. Rango 7/30 días.

Definiciones (`panel-data.ts`):
- *Resueltas por IA*: conversaciones del período cerradas/resueltas sin haber pasado por `pending_human`.
- *Derivadas*: con evento `handoff_accepted` u `operator_initiated` en el período.
- *Tiempo de primera respuesta IA*: `first_bot_message.created_at − first_inbound.created_at`.
- *Tiempo de primera respuesta humana*: primer mensaje `agent` − `handoff_requested_at`.
- *Costo estimado*: `sum(chatbot_usage.cost_usd)`.

### 18.7 Equipo — `/panel/equipo`

Tabla de miembros (nombre, email, rol, estado, disponible, conversaciones activas / máximo), botón **Invitar**, edición en `Modal`. Mensaje claro de qué puede hacer cada rol.

---

## 3. Autenticación y permisos

### 3.1 Integración con la autenticación actual

| Etapa | Estado |
| --- | --- |
| Hoy [HECHO] | Contraseña compartida → cookie `ry_panel` (HMAC). Sin identidad |
| Fase 3 [PROPUESTA] | Supabase Auth (email + contraseña; invitaciones por email). Cliente `@supabase/ssr` en servidor (`createServerClient` con `cookies()`), sesión en cookies `sb-*` httpOnly. `proxy.ts` acepta sesión Supabase **o** cookie legacy (si `PANEL_LEGACY_LOGIN=true`). `requirePanelSession()` se mantiene como alias que delega en `requireMember('operator')` |
| Sesión legacy | Se mapea a un miembro virtual `{role: 'owner', businessId: <negocio por defecto>, displayName: 'Demo'}`; útil para la demo pública. Las acciones de atención humana registran `actor_member_id = null` con `payload.legacy = true` |
| Fin de migración | `PANEL_LEGACY_LOGIN=false` (D-02) |

[PENDIENTE] verificar en `node_modules/next/dist/docs` y en la documentación de `@supabase/ssr` la integración con `proxy.ts` y `cacheComponents` antes de T-03.2.

```ts
// src/lib/auth/session.ts
export interface Member { id: string | null; userId: string | null; businessId: string;
  role: "owner" | "admin" | "operator"; displayName: string; legacy: boolean }

export async function getCurrentMember(): Promise<Member | null>  // connection() + cookies
export async function requireMember(min: "operator" | "admin" | "owner"): Promise<Member> // redirect("/login") o forbidden()
```

### 3.2 Matriz de permisos

| Permiso | owner | admin | operator |
| --- | :-: | :-: | :-: |
| Agenda y turnos (existente) | ✓ | ✓ | ✓ |
| Ver bandeja de conversaciones | ✓ | ✓ | ✓ |
| Tomar / responder / liberar / devolver / resolver (propias) | ✓ | ✓ | ✓ |
| Reasignar, cerrar cualquier conversación | ✓ | ✓ | — |
| Ver base de conocimiento | ✓ | ✓ | lectura |
| Crear / editar / eliminar fuentes | ✓ | ✓ | — |
| Ver preguntas sin respuesta | ✓ | ✓ | ✓ |
| Resolver preguntas sin respuesta | ✓ | ✓ | — |
| Configurar chatbot (mensajes, horario, tono) | ✓ | ✓ | — |
| Elegir modelo y tope de gasto | ✓ | — | — |
| Ver métricas y consumo | ✓ | ✓ | métricas sin costos |
| Invitar / editar miembros | ✓ | ✓ (no owners) | — |
| Exportar / borrar datos de un contacto | ✓ | — | — |
| Ver auditoría | ✓ | — | — |

Implementación: `permissions.ts` exporta `can(member, permission)`; cada Server Action y página la consulta; la UI oculta lo no permitido (pero la seguridad está en el servidor).
