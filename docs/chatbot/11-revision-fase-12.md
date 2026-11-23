# 11 · Revisión de la Fase 12 (seguridad y pruebas)

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

Resultado de ejecutar T-12.1 a T-12.6. Lo que **no** se pudo verificar sin cuentas reales está marcado como pendiente.

## 1. Cobertura de las pruebas de seguridad (09 §Pruebas de seguridad)

| ID | Dónde se prueba | Estado |
| --- | --- | --- |
| S-01 | `tests/chatbot/panel.test.ts`, `tests/chatbot/operator.test.ts` | Verde |
| S-02 | `tests/security/data-protection.test.ts` (las 12 acciones de conversación, fuentes, preguntas sin respuesta y equipo, con un owner y un admin de otro negocio) | Verde |
| S-03 | `tests/chatbot/panel.test.ts` (404 con la conversación de otro negocio) | Verde |
| S-04 | `tests/auth/ingest.test.ts`, `tests/db/migrations.test.ts` | Verde |
| S-05 | `tests/auth/storage.test.ts` (ruta de otro negocio o con `..` rechazada; la lectura es solo por el servidor) | Verde |
| S-06 | `tests/security/data-protection.test.ts`, `tests/auth/knowledge-actions.test.ts`, `tests/auth/permissions.test.ts` | Verde |
| S-07 | `tests/regression/webhook.test.ts` (R-12) | Verde |
| S-08 | `tests/security/endpoints.test.ts` (los 5 jobs sin firma ni clave → 401), `tests/chatbot/job.test.ts` | Verde |
| S-09 | `tests/security/data-protection.test.ts` | Requiere la migración 0012 aplicada |
| S-10 | — | No aplica: el widget web es fase 2 (D-11) |
| S-11 | `tests/security/endpoints.test.ts`, `tests/auth/proxy.test.ts` | Verde |
| S-12 | `tests/unit/extract.test.ts` (IP privadas, DNS que resuelve a IP privada, redirecciones) | Verde |

Además: `tests/security/limits.test.ts` (T-12.4) y `tests/security/login-throttle.test.ts` (límite de login; requiere 0012).

## 2. Límites de consumo (07 §19.10, T-12.4)

| Límite | Estado |
| --- | --- |
| 20 entrantes / 10 min y 100 / día por contacto (W-11) | Ya existía; ahora con prueba |
| 2 000 caracteres de entrante | Ya existía |
| **60 respuestas del bot por conversación y día** | Nuevo. Al pasarse: un aviso («Estás enviando muchos mensajes…») y silencio; el aviso es uno por día. La spec no define la conducta, se reutilizó la de los demás límites |
| Tope mensual del negocio y tope diario global (AI-12) | Ya existía |
| **50 fuentes por día y 200 MB de archivos por mes** | Nuevo (`createSource`). Las fuentes eliminadas cuentan para el cupo diario; el mes es calendario UTC |
| **100 turnos por día en la zona de pruebas** | Nuevo. Cuenta los turnos que llegaron a la IA (operación `playground` en `chatbot_usage`), ventana móvil de 24 h |
| Kill switch `CHATBOT_ENABLED` | Ya existía |

## 3. Retención y borrado (T-12.6)

- Mantenimiento (`runMaintenance` → `purgeExpired`): `webhook_events` 30 días; `conversations` (y por cascada mensajes, eventos y asignaciones) y `unanswered_questions` 12 meses (D-10); `login_attempts` 1 día. `RNF-10` dice «retención configurable»: no hay columna para configurarla y no se inventó; está fija en constantes de `maintenance.ts`.
- «Borrar datos de este contacto»: solo owner, botón en el detalle de la conversación. Función SQL transaccional `delete_contact_data` (migración 0012): borra el contacto con su cascada, las preguntas sin respuesta de sus conversaciones y los `inbound_messages` y `webhook_events` que contienen su teléfono. Queda en `audit_log` como `contact.erased` con solo el id del contacto y los conteos.
- Alcance exacto de la spec: no toca `customers`, `appointments` ni `messages` (recordatorios), que son datos de la agenda del negocio. Si se quiere borrar también eso, es una decisión nueva.
- **Pendiente de decisión**: `inbound_messages` de contactos que no se borran por contacto ni se purgan por retención (la spec solo fija retención para webhooks, conversaciones y preguntas).
- «Exportar datos de un contacto» aparece en la matriz de permisos (06 §3.2) pero no está en ninguna tarea del plan; no se implementó.

## 4. Auditoría y login

- `audit_log.ip_hash`: hash SHA-256 con sal `AUDIT_IP_SALT` de la IP de la petición (primera de `x-forwarded-for`). Sin sal definida queda en `null`. Aplicado a configuración, miembros, fuentes y borrado de contacto.
- Login legacy: 10 intentos fallidos por IP en 15 min (tabla `login_attempts`, migración 0012). Un ingreso correcto limpia los fallos de esa IP. Si la tabla no responde, se deja pasar y se registra un aviso (bloquear a todos por una falla del contador sería peor).

## 5. Revisión de seguridad (T-12.5, checklist 07 §19.13)

- `npm audit --omit=dev`: **0 vulnerabilidades** en dependencias de producción. `npm audit` completo: 7 moderadas, todas en la cadena de herramientas de ESLint (desarrollo); no se aplicó `npm audit fix` para no actualizar a ciegas.
- Endpoints (`route.ts`): todos exigen firma QStash, `ADMIN_API_KEY`, firma de Meta o sesión; solo `src/app/auth/callback` y `src/app/auth/session` son públicos por diseño (este último valida el `Origin`).
- Desviación de 07 §19.5 («`/api/panel/*` solo `GET`»): `POST /api/panel/conversations/[id]/messages` envía el mensaje del operador. Exige sesión, `Origin` igual al del sitio y el servicio vuelve a comprobar asignación y negocio. Se dejó así por el envío con `client_request_id`; **decisión abierta** si se prefiere moverlo a una Server Action.
- Aislamiento por negocio: se verifica por comportamiento (S-01…S-05). Un chequeo estático de «cada `.from()` lleva `business_id`» se probó y se descartó: marca decenas de consultas internas legítimas (jobs que ya cargaron la fila por id) y obligaría a una lista de excepciones frágil.
- Matriz de permisos: coincide con 06 §3.2; se añadió `contact.erase` (owner). «Ver auditoría» (owner) no tiene pantalla todavía.

## 6. Comportamiento corregido en esta fase

- **W-05**: un error transitorio del proveedor de IA hacía que, tras agotar los reintentos de QStash, el cliente se quedara sin respuesta. Ahora el job lee `Upstash-Retried` y, en el último intento, responde con el mensaje de «sin información» y la oferta de derivación. La cabecera `Upstash-Retried` no se verificó con QStash real.

## 7. Pendiente (necesita una acción o decisión tuya)

- Aplicar `supabase/apply/dev-0012.sql` en `recordaya-dev` y, después, la migración 0012 en producción (T-13.1).
- Definir `AUDIT_IP_SALT` en `.env.local` y Vercel.
- T-12.2 (evaluación de IA, AI-*) depende de T-07.7/T-02.2 (set dorado), que necesitan tu revisión.
- W-01…W-15 con un número de prueba de Meta (T-12.3 «con número de prueba»): solo se ejecutaron con el simulador.

## 8. Set dorado, ejecutor de evaluaciones y privacidad (T-02.2, T-07.7, T-13.4)

- **Set dorado** (`tests/ai-evals/`): 170 casos en 11 grupos (AI-01 … AI-11) sobre una barbería de ejemplo (20 FAQ + 3 textos) y dos variantes (precios en conflicto, FAQ envenenada). Cada caso tiene un `expected` que se puntúa solo (`score.ts`, con pruebas en `tests/unit/ai-evals.test.ts`). **Pendiente tu revisión** de tono y contenido (criterio de «hecho» de T-02.2).
- **Ejecutor** (`npm run eval:chatbot`): carga los fixtures en negocios de prueba, corre los casos por la zona de pruebas (mismo motor, sin enviar nada), mide recuperación top-5 y escribe `tests/ai-evals/reports/`. Falla si un grupo no llega a su umbral. Se verificó con proveedores falsos (solo prueba que el ejecutor funciona); **no se ha corrido con Gemini ni Voyage reales**, por lo que no hay ninguna métrica de calidad todavía. Ver `tests/ai-evals/README.md`.
- **Fragmentos sospechosos** (07 §19.8 capa 7, no estaba implementado): al ingerir se marca `metadata.suspicious` en los fragmentos con órdenes dirigidas a una IA y la ficha de la fuente muestra un aviso. Es una heurística de frases: puede dar falsos positivos y falsos negativos.
- **`PROMPT_VERSION`** (T-12.2) ahora existe en `prompt.ts` y se registra en cada reporte.
- **`/privacidad` y `/eliminacion-de-datos`** actualizadas: asistente con IA, qué se envía a Google y a Voyage (no el teléfono ni el nombre), advertencia de capa gratuita, conservación (12 meses / 30 días) y borrado por contacto. **Texto sin revisión legal y sin verificar contra las condiciones vigentes de Google y Voyage**: revisar antes de publicar.
