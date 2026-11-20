# 07 · Seguridad

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

---

## 19.1 Modelo de amenazas (resumen)

| Actor | Objetivo | Superficie |
| --- | --- | --- |
| Cliente final malicioso | Extraer prompt/datos de otros, hacer decir falsedades, agotar presupuesto, acosar operadores | WhatsApp, widget (F2) |
| Miembro de otro negocio | Leer conversaciones/conocimiento ajeno | Panel, APIs |
| Operador con permisos bajos | Cambiar configuración, ver costos, borrar fuentes | Server Actions |
| Atacante externo | Falsificar webhooks/jobs, SSRF por URL, archivos maliciosos, fuerza bruta de login | Endpoints públicos |
| Documento envenenado | Inyectar instrucciones vía base de conocimiento | Ingesta |

## 19.2 Autenticación

- Supabase Auth (email + contraseña, mínimo 10 caracteres; invitación obligatoria, sin registro abierto: `disable_signup` en el proyecto o validación de invitación en el callback). [PENDIENTE] configurar en el dashboard de Supabase.
- Sesiones en cookies httpOnly `Secure`, `SameSite=Lax`.
- Login legacy: se mantiene la comparación en tiempo constante y la demora; se agrega límite de 10 intentos/15 min por IP (tabla `login_attempts` o contador en `audit_log`), solo mientras `PANEL_LEGACY_LOGIN=true`.
- Recuperación de contraseña por email de Supabase.

## 19.3 Autorización

- **Toda** Server Action y Route Handler del panel: `requireMember(rol)` + `can(member, permiso)`; el `business_id` se toma de la sesión, nunca de parámetros del cliente.
- Cada consulta del módulo incluye `.eq('business_id', member.businessId)`; las de una entidad por id usan `.eq('id', id).eq('business_id', businessId)` (no basta el id).
- Revisión: regla de lint propia o *checklist* de PR "¿todas las consultas filtran por business_id?". Prueba S-02 automatiza el recorrido de acciones con un miembro de otro negocio.

## 19.4 Separación de datos y RLS

- Capa principal: DAL en el servidor con clave secreta (patrón actual [HECHO]) + filtro por negocio obligatorio.
- Defensa en profundidad: RLS activado en todas las tablas nuevas con políticas por membresía (`0010`). Sin `grant` a `authenticated`, ni la clave publicable ni un JWT de usuario pueden leer datos.
- La clave secreta solo existe en variables de entorno del servidor; `import "server-only"` en todos los módulos que la usan (patrón [HECHO]).
- Storage: bucket privado; rutas con prefijo `{business_id}/`; URLs firmadas de subida generadas por el servidor para una ruta fija; lectura solo por el servidor.
- Función `match_knowledge_chunks` exige `p_business_id`.

## 19.5 Protección de APIs

| Endpoint | Protección |
| --- | --- |
| Jobs nuevos | Firma QStash (rechazo 401 sin firma), validación Zod del body |
| `/api/panel/*` | Sesión + membresía; solo `GET`; `Cache-Control: no-store` |
| Server Actions | Next.js valida origen (CSRF) [HECHO por el framework; verificar config `serverActions.allowedOrigins` si hay dominio propio] |
| Widget (F2) | Clave pública + `Origin` permitido + token firmado + rate limit + Turnstile opcional |
| API existente con `ADMIN_API_KEY` | Sin cambios |

## 19.6 Webhooks y firmas

- Se mantiene `verifyWebhookSignature` (HMAC-SHA256, comparación en tiempo constante) [HECHO]; no se modifica.
- Se agrega verificación de que `metadata.phone_number_id` corresponda a un número conocido (`businesses.wa_phone_number_id` o `WHATSAPP_PHONE_NUMBER_ID`); si no, se registra y no se procesa con el chatbot.
- Jobs: `verifyQStashSignature` con `clockTolerance: 5` [HECHO].

## 19.7 Credenciales

- Nuevas claves (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `CHATBOT_PROMPT_CANARY`, `AUDIT_IP_SALT`) solo en Vercel (Production/Preview separados) y `.env.local`; nunca en el repositorio (`.gitignore` ya cubre `.env*` [HECHO]).
- Claves de IA con límite de gasto configurado en la consola del proveedor (segunda barrera además de los topes internos).
- El token de WhatsApp sigue siendo global; un futuro multi-número requerirá cifrar tokens por negocio (fuera de alcance).
- Rotación documentada en el runbook (§23).

## 19.8 Prompt injection

Ver detalle en [04-motor-ia-y-rag.md §14.5](04-motor-ia-y-rag.md#145-guardas-cómo-se-aplican-las-reglas-obligatorias). Resumen de capas:

1. **Sin herramientas con efectos** en el MVP: aunque el modelo sea manipulado, no puede cancelar turnos, enviar mensajes a terceros ni leer otras conversaciones.
2. Separación estructural: reglas en `system`; fuentes e historial como datos delimitados y escapados.
3. Salida estructurada validada con Zod; texto fuera del esquema se descarta.
4. Verificación de hechos contra fuentes (números, URLs, teléfonos, emails).
5. Canario y detección de fragmentos del prompt en la salida.
6. Heurística de entrada (frases tipo "ignora las instrucciones", "system prompt", "eres ahora…"): se registra `injection_suspected` y aumenta el umbral de confianza para ese turno.
7. Contenido de la base: al ingerir, se marca en `metadata.suspicious = true` todo fragmento con patrones de instrucciones dirigidas a una IA; el admin lo ve en la UI de la fuente.
8. Set de pruebas AI-07 (30 casos) obligatorio antes de cambiar prompt o modelo.

## 19.9 Validación de documentos

Tamaño máximo, tipo real por *magic bytes* (no por extensión ni `Content-Type`), límites de páginas/caracteres/fragmentos, anti zip-bomb en DOCX, PDF cifrados rechazados, no se ejecuta ningún contenido (no se renderiza HTML de URLs; solo texto), SSRF bloqueado (IP privadas, `169.254.169.254`, `localhost`, IPv6 locales, redirecciones re-validadas), nombres de archivo saneados (`[^\w.-]` → `_`, máx. 100 caracteres).

## 19.10 Límites de consumo y rate limiting

| Límite | Valor por defecto | Dónde |
| --- | --- | --- |
| Entrantes por contacto | 20 / 10 min, 100 / día | Router (conteo en `conversation_messages`) |
| Longitud de entrante procesada | 2 000 caracteres | Engine |
| Respuestas del bot por conversación por día | 60 | Engine |
| Tope mensual por negocio | `monthly_budget_usd` (20) | `assertBudget` antes de cada llamada |
| Tope diario global | `CHATBOT_GLOBAL_DAILY_BUDGET_USD` (50) | `assertBudget` |
| Ingestas por negocio | 50 fuentes / día, 200 MB / mes | Server Actions |
| Zona de pruebas | 100 turnos / día por negocio | Server Action |
| Kill switch | `CHATBOT_ENABLED=false` | Router (ruta legacy) |

Al alcanzar el 80 % del tope mensual: banner en el panel. Al 100 %: modo "solo derivación" (`budget_exhausted`).

## 19.11 Auditoría y registro de eventos

- `conversation_events`: todo cambio de estado y acción sobre conversaciones.
- `audit_log`: cambios de configuración, miembros, borrado de fuentes, exportaciones y borrados de datos personales (con diff sin secretos y hash de IP).
- `chatbot_usage`: cada llamada a proveedores.
- Logs de aplicación (`src/lib/logger.ts`): JSON `{level, scope, msg, businessId, conversationId, wamid, durationMs}`; **sin** cuerpo de mensajes, teléfonos enmascarados (`5989****456`), sin claves. Los `console.error` existentes no se modifican.

## 19.12 Protección de datos personales

- Datos tratados: teléfono, nombre de perfil, contenido de mensajes, documentos del negocio (pueden contener datos de terceros).
- Minimización: no se envía el teléfono al proveedor de IA (el prompt usa nombre de pila o "el cliente"); el historial enviado se limita a 12 mensajes.
- Proveedores de IA como encargados de tratamiento: verificar sus políticas de retención y uso para entrenamiento [PENDIENTE] y reflejarlo en `/privacidad` (actualizar texto: uso de IA, proveedores, finalidad, retención) — tarea T-13.4.
- Retención: conversaciones y `unanswered_questions` 12 meses (D-10); `webhook_events` 30 días; textos extraídos mientras la fuente exista.
- Derecho de supresión: acción owner "Borrar datos de este contacto" (borra `chat_contacts` en cascada, sus `inbound_messages` y `webhook_events` que lo contengan) — se integra con la página existente `/eliminacion-de-datos` [HECHO que existe].
- Cumplimiento normativo (p. ej. Ley 18.331 de Uruguay, por la zona horaria por defecto del proyecto) [PENDIENTE] revisión legal del responsable.

## 19.13 Checklist de seguridad por PR

- [ ] ¿Cada consulta filtra por `business_id` de la sesión/número?
- [ ] ¿La acción llama a `requireMember` con el rol correcto?
- [ ] ¿Entradas validadas con Zod (longitudes incluidas)?
- [ ] ¿Ningún secreto en logs ni respuestas?
- [ ] ¿Contenido externo tratado como datos (escape, sin ejecución)?
- [ ] ¿Pruebas S-* afectadas actualizadas?
