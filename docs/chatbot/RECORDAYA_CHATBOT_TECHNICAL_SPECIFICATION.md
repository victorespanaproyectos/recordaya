# RecordaYa · Chatbot inteligente con atención humana
## Especificación técnica (documento principal)

| | |
| --- | --- |
| Versión | 1.0 (borrador para aprobación) |
| Fecha | 2026-11-19 |
| Estado | Diseño. **No se modificó código, base de datos ni configuración de Meta.** |
| Repositorio auditado | `main` @ `f1ad32b` |
| Alcance | Ampliación de RecordaYa (no es una app nueva ni una reescritura) |

> **Convención usada en toda la documentación**
> - **[HECHO]**: comprobado leyendo el repositorio (se cita archivo y línea cuando aplica).
> - **[PROPUESTA]**: decisión de diseño de esta especificación.
> - **[PENDIENTE]**: no se puede comprobar desde el repositorio; se indica qué falta y qué decisión depende de ello.

---

## Índice central

| # | Documento | Contenido (secciones del entregable) |
| --- | --- | --- |
| 0 | **Este documento** | 1 Resumen ejecutivo · 4 Alcance · 5 Requerimientos funcionales · 6 No funcionales · 26 Criterios de aceptación · Decisiones pendientes |
| 1 | [01-auditoria.md](01-auditoria.md) | 2 Estado actual · 3 Auditoría técnica (estructura, BD, Meta, riesgos, reutilizables) |
| 2 | [02-arquitectura.md](02-arquitectura.md) | 7 Arquitectura · 8 Diagramas de arquitectura · 9 Secuencia · 10 Flujo · 17 Integración con Meta · Widget web · Estructura de archivos |
| 3 | [03-modelo-de-datos.md](03-modelo-de-datos.md) | 11 Modelo E-R · 12 Diccionario de datos · Migraciones SQL y orden · RLS · Reversión |
| 4 | [04-motor-ia-y-rag.md](04-motor-ia-y-rag.md) | 14 Motor conversacional · 15 Diseño RAG · Comparación de proveedores · Capa de abstracción · Reglas obligatorias |
| 5 | [05-atencion-humana.md](05-atencion-humana.md) | 16 Atención humana: estados, transiciones, concurrencia, horarios, notificaciones |
| 6 | [06-apis-e-interfaz.md](06-apis-e-interfaz.md) | 13 Diseño de APIs · 18 Diseño de interfaz · Permisos y autenticación |
| 7 | [07-seguridad.md](07-seguridad.md) | 19 Seguridad (aislamiento, RLS, webhooks, prompt injection, límites, datos personales) |
| 8 | [08-plan-de-implementacion.md](08-plan-de-implementacion.md) | 20 Plan de desarrollo: 14 fases, tareas con ID y criterios |
| 9 | [09-plan-de-pruebas.md](09-plan-de-pruebas.md) | 21 Plan de pruebas · 22 Pruebas de regresión |
| 10 | [10-despliegue-costos-riesgos.md](10-despliegue-costos-riesgos.md) | 23 Despliegue · 24 Costos y escalabilidad · 25 Riesgos · 27 Checklist de producción |

Orden de lectura recomendado para el desarrollador que implementa: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → **8 (ejecutar tareas en orden)** → 9 → 10.

---

## 1. Resumen ejecutivo

RecordaYa es hoy un sistema **de un solo número de WhatsApp** que envía confirmaciones y recordatorios de turnos (24 h y 2 h antes) mediante plantillas aprobadas, programadas con Upstash QStash, y que interpreta respuestas «1/2» para confirmar o cancelar. Tiene un panel web protegido por **una contraseña compartida** y una base Supabase accedida **solo desde el servidor con la clave secreta**.

La ampliación agrega, dentro de la misma aplicación Next.js y la misma base:

1. **Asistente de IA por negocio** que responde consultas por WhatsApp usando **solo** información cargada y autorizada por el negocio (RAG con pgvector).
2. **Base de conocimiento** (FAQ, texto manual, PDF, TXT, DOCX, URL) con procesamiento asíncrono, estados y versiones.
3. **Derivación a personas** con cola, toma atómica de conversaciones, horarios de atención y devolución a la IA.
4. **Bandeja de conversaciones y métricas** integradas en el panel actual (`/panel`).
5. **Usuarios y roles reales** (Supabase Auth + membresías por negocio), necesarios para operadores. La contraseña compartida actual queda como modo de compatibilidad temporal.

Decisiones de arquitectura principales **[PROPUESTA]**:

| Tema | Decisión |
| --- | --- |
| Número de WhatsApp | **El mismo número y el mismo webhook.** Un *router* de mensajes entrantes decide, antes de la lógica actual, si el mensaje es respuesta a un recordatorio, de una conversación con humano, o para el chatbot. Con el chatbot desactivado el comportamiento es idéntico al actual (bit a bit). |
| Procesamiento de IA | Fuera del webhook: el webhook guarda el mensaje (como hoy) y encola un job en **QStash** (`/api/jobs/chatbot-reply`), con reintentos, deduplicación por `wamid` y agrupación de ráfagas. |
| Proveedor de IA | Generación con **Claude** (Anthropic) detrás de una interfaz `LlmProvider`; embeddings con un proveedor separado detrás de `EmbeddingProvider` (recomendado: Voyage AI). Ninguna parte de la app importa el SDK del proveedor fuera de `src/lib/chatbot/providers/`. |
| Vectores | **pgvector** en el mismo Supabase + búsqueda de texto completo (`spanish`) combinadas por *Reciprocal Rank Fusion* en una función SQL. |
| Respuestas fundamentadas | Salida estructurada (JSON validado con Zod) que obliga al modelo a declarar si la respuesta está respaldada por los fragmentos recuperados; si no, se responde el mensaje de "sin información" configurado y se registra la pregunta. |
| Atención humana | Estados `bot → pending_human → human → resolved → closed`; toma con `UPDATE … WHERE assigned_member_id IS NULL` atómico; la IA no responde mientras hay humano. |
| Panel | Nuevas secciones dentro de `/panel` (Conversaciones, Conocimiento, Chatbot, Equipo). Actualización por *polling* en el MVP; Supabase Realtime en fase 2. |
| Widget web | **Fase 2** (Fase 11 del plan), diseñado pero fuera del MVP. |
| Recordatorios | **Sin cambios** en `reminders.ts`, `notify.ts`, `service.ts`, jobs de QStash ni plantillas. |

Costo variable dominante: la IA. Con el modelo por defecto (`claude-opus-5-5`, esfuerzo `low`) se estima **≈ USD 0,02–0,03 por respuesta**; con `claude-haiku-5-5` **≈ USD 0,001**. Ver [10-despliegue-costos-riesgos.md](10-despliegue-costos-riesgos.md#24-estimación-de-costos). Se incluyen topes de gasto por negocio y un *kill switch* global.

---

## 4. Alcance de la ampliación

### 4.1 Incluido en el MVP (Fases 1–10, 12–14)

- Configuración del asistente por negocio (activación, nombre, tono, instrucciones, idioma, mensajes, horarios humanos, modelo y límites).
- Base de conocimiento: FAQ, texto manual (con categoría: productos/servicios, políticas, horarios, contacto, otro), PDF, TXT, DOCX y URL (una página, sin rastreo).
- RAG: extracción, fragmentación, embeddings, búsqueda híbrida, construcción de contexto, respuesta con verificación de respaldo.
- Canal WhatsApp sobre la integración existente.
- Derivación a humano: oferta, confirmación, cola, toma, respuesta del operador, liberación, devolución a IA, resolución, cierre automático.
- Bandeja de conversaciones, detalle con historial unificado (incluye recordatorios enviados), métricas y preguntas sin respuesta.
- Usuarios con roles `owner`, `admin`, `operator` por negocio.
- Registro de consumo de IA y costos estimados; topes mensuales.
- Infraestructura de pruebas (Vitest) y CI (GitHub Actions), hoy inexistentes.

### 4.2 Fuera del MVP (fase 2 o posterior)

| Ítem | Motivo |
| --- | --- |
| Widget web insertable | Requiere endpoints públicos, CORS, anti-abuso y sesiones anónimas; el canal prioritario es WhatsApp. Diseñado en [02-arquitectura.md §Widget](02-arquitectura.md#widget-web-fase-2). |
| Que la IA confirme/cancele/reprograme turnos (herramientas) | Riesgo de acciones irreversibles por interpretación errónea. En el MVP la IA solo **informa** y remite al flujo «1/2» existente. |
| Rastreo de sitios web completos | Costo y riesgo SSRF; en MVP una URL = una página. |
| Notificaciones por email / WhatsApp al operador | Requieren proveedor de email o plantilla aprobada ([PENDIENTE] D-07). En MVP: aviso en el panel + notificación del navegador. |
| Supabase Realtime en la bandeja | Requiere exponer clave publicable y RLS con JWT de usuario; MVP usa polling cada 5 s. |
| OCR de PDF escaneados, imágenes, audios | Se registran como "contenido no soportado" y se ofrece humano. |
| Múltiples números de WhatsApp (uno por negocio) | El modelo de datos lo soporta (`businesses.wa_phone_number_id`), pero hoy el token y el número son globales por variables de entorno ([HECHO] `src/lib/env.ts:418`). |

---

## 5. Requerimientos funcionales

Prioridad: **M** = MVP obligatorio, **F2** = fase 2.

### 5.1 Configuración del chatbot (RF-CFG)

| ID | Requerimiento | Prioridad |
| --- | --- | --- |
| RF-CFG-01 | Un admin activa/desactiva el chatbot de su negocio. Desactivado ⇒ el procesamiento de mensajes entrantes es exactamente el actual. | M |
| RF-CFG-02 | Configurar nombre del asistente, descripción del negocio, personalidad/tono (formal, cercano, neutro + texto libre), instrucciones generales e idioma (es por defecto). | M |
| RF-CFG-03 | Configurar mensajes: bienvenida, oferta de transferencia, confirmación de transferencia, fuera de horario, sin información, cierre. Con variables `{negocio}`, `{asistente}`, `{proximo_horario}`. | M |
| RF-CFG-04 | Configurar horarios de atención humana semanales en la zona horaria del negocio, con excepciones por fecha (feriados). | M |
| RF-CFG-05 | Configurar comportamiento: longitud máxima de respuesta, ofrecer humano tras N respuestas sin información (por defecto 2), inactividad para cerrar (por defecto 24 h), saludo solo en el primer mensaje. | M |
| RF-CFG-06 | Configurar modelo de IA (lista blanca) y tope mensual de gasto en USD. Solo `owner`. | M |
| RF-CFG-07 | Probar el asistente desde el panel ("zona de pruebas") sin enviar WhatsApp; las pruebas no cuentan como conversaciones reales pero sí como consumo. | M |

### 5.2 Base de conocimiento (RF-KB)

| ID | Requerimiento | Prioridad |
| --- | --- | --- |
| RF-KB-01 | Alta, edición y baja de FAQ (pregunta + respuesta). | M |
| RF-KB-02 | Alta, edición y baja de texto manual con título y categoría (productos/servicios, políticas, horarios, contacto, otro). | M |
| RF-KB-03 | Carga de archivos PDF, TXT y DOCX hasta 10 MB (configurable), con validación por tipo real (*magic bytes*). | M |
| RF-KB-04 | Alta de URL pública (una página), con re-lectura manual. | M |
| RF-KB-05 | Listado con tipo, título, categoría, estado (`pending`, `processing`, `ready`, `failed`, `disabled`), fragmentos, fecha de última actualización y último procesamiento, y autor. | M |
| RF-KB-06 | Ver el texto extraído y los fragmentos de una fuente. | M |
| RF-KB-07 | Reemplazar un archivo o editar un texto crea una **nueva versión**; la anterior sigue respondiendo hasta que la nueva quede `ready` (sin huecos). | M |
| RF-KB-08 | Ver el error de procesamiento legible y reintentar. | M |
| RF-KB-09 | Desactivar una fuente sin borrarla (deja de usarse en respuestas). | M |
| RF-KB-10 | Toda la información queda aislada por negocio. | M |

### 5.3 Motor conversacional (RF-AI)

| ID | Requerimiento | Prioridad |
| --- | --- | --- |
| RF-AI-01 | Responder en lenguaje natural usando solo fragmentos recuperados de la base del negocio y datos del sistema autorizados (nombre, dirección, próximo turno del cliente). | M |
| RF-AI-02 | Mantener contexto de la conversación (últimos 12 mensajes + resumen). | M |
| RF-AI-03 | Ante ambigüedad, pedir una aclaración concreta (máximo una vez seguida). | M |
| RF-AI-04 | Ante falta de información: decirlo, no inventar, registrar en `unanswered_questions` y ofrecer humano según configuración. | M |
| RF-AI-05 | Detectar pedido explícito de humano («quiero hablar con alguien», «persona», «asesor») y ofrecer/derivar. | M |
| RF-AI-06 | No revelar instrucciones internas ni seguir instrucciones del cliente o de documentos que intenten cambiar las reglas. | M |
| RF-AI-07 | Si el cliente tiene un turno próximo y pregunta por él, informar fecha/hora y recordar que puede responder 1/2. No modifica turnos. | M |
| RF-AI-08 | Mensajes no textuales (audio, imagen, ubicación): respuesta configurada + oferta de humano. | M |

### 5.4 Atención humana (RF-HUM)

| ID | Requerimiento | Prioridad |
| --- | --- | --- |
| RF-HUM-01 | Ofrecer transferencia y pedir confirmación (botones «Sí, con una persona» / «No, sigo con el asistente»). | M |
| RF-HUM-02 | Registrar la derivación con motivo (`customer_request`, `no_information`, `low_confidence`, `unsupported_content`, `sensitive_topic`, `operator_initiated`). | M |
| RF-HUM-03 | Cola de pendientes visible para operadores; un operador toma la conversación (asignación exclusiva). | M |
| RF-HUM-04 | Con operador asignado la IA no responde. | M |
| RF-HUM-05 | El operador ve historial completo, motivo, resumen generado y datos del cliente/turno. | M |
| RF-HUM-06 | Fuera de horario: se informa la próxima franja de atención. | M |
| RF-HUM-07 | El operador puede liberar (vuelve a cola), devolver a IA, resolver o cerrar. | M |
| RF-HUM-08 | Dos operadores nunca pueden responder la misma conversación a la vez. | M |
| RF-HUM-09 | Fuera de la ventana de 24 h de WhatsApp, el envío libre se bloquea y se ofrece plantilla de reapertura ([PENDIENTE] D-08). | M |
| RF-HUM-10 | Disponibilidad del operador (disponible/ausente) y límite de conversaciones simultáneas. | M |

### 5.5 Panel (RF-PAN)

| ID | Requerimiento | Prioridad |
| --- | --- | --- |
| RF-PAN-01 | Métricas: total de conversaciones, resueltas por IA, derivadas, pendientes, preguntas sin respuesta, tiempo medio de primera respuesta (IA y humano), consumo de tokens y costo estimado; filtros 7/30 días. | M |
| RF-PAN-02 | Bandeja: listado, búsqueda por nombre/teléfono/texto, filtros por estado, canal, operador, fecha; contador de no leídos. | M |
| RF-PAN-03 | Gestión de equipo: invitar por email, rol, disponibilidad, desactivar. | M |
| RF-PAN-04 | Preguntas sin respuesta: listar, marcar resuelta enlazando la fuente creada, ignorar. | M |

### 5.6 Canales (RF-CH)

| ID | Requerimiento | Prioridad |
| --- | --- | --- |
| RF-CH-01 | WhatsApp sobre el webhook y número existentes. | M |
| RF-CH-02 | Coexistencia con recordatorios según las reglas de enrutamiento de [02-arquitectura.md §5](02-arquitectura.md#5-enrutamiento-de-mensajes-entrantes-recordatorios-vs-chatbot). | M |
| RF-CH-03 | Widget web insertable. | F2 |

---

## 6. Requerimientos no funcionales

| ID | Categoría | Requerimiento | Medición |
| --- | --- | --- | --- |
| RNF-01 | Compatibilidad | Con `chatbot_settings.enabled = false` (o sin fila) para un negocio, toda la suite de regresión R-* pasa sin cambios. | [09-plan-de-pruebas.md](09-plan-de-pruebas.md) §22 |
| RNF-02 | Latencia webhook | El `POST /api/webhooks/whatsapp` responde 200 en < 1 s p95 (hoy usa `after()`; se mantiene). | Logs de Vercel |
| RNF-03 | Latencia respuesta IA | Respuesta enviada al cliente < 12 s p90 desde la recepción (incluye agrupación de 2,5 s). | `conversation_messages.created_at` vs `inbound_messages.received_at` |
| RNF-04 | Idempotencia | Un mismo `wamid` nunca genera dos respuestas automáticas. | Prueba W-03 |
| RNF-05 | Aislamiento | Ninguna consulta de datos del chatbot se ejecuta sin `business_id` derivado de la sesión o del número receptor. | Pruebas S-* + revisión |
| RNF-06 | Disponibilidad degradada | Si el proveedor de IA falla tras reintentos, el cliente recibe el mensaje de "sin información" + oferta de humano; nunca silencio total. | Prueba W-05 |
| RNF-07 | Costos | Tope mensual por negocio aplicado antes de cada llamada; alcanzado el tope, el chatbot pasa a modo "solo derivación". | Prueba AI-12 |
| RNF-08 | Mantenibilidad | Módulo en `src/lib/chatbot/**`; los módulos existentes no importan del chatbot salvo `process-webhook.ts` (router) y `applyStatus`. | Revisión |
| RNF-09 | Observabilidad | Logs estructurados JSON con `scope`, `businessId`, `conversationId`, `wamid` (sin texto del cliente ni teléfono completo). | Revisión |
| RNF-10 | Privacidad | Teléfonos enmascarados en logs; retención configurable de conversaciones (por defecto 12 meses); borrado por contacto. | Prueba S-09 |
| RNF-11 | Accesibilidad | Nuevas pantallas: navegación por teclado, contraste AA, etiquetas ARIA, igual que el panel actual. | Revisión manual |
| RNF-12 | Escalabilidad | Diseño válido hasta ~100 negocios y ~250 k respuestas/mes sin cambios de arquitectura (ver §24). | Estimación |

---

## 26. Criterios de aceptación globales

La ampliación se acepta cuando **todos** se cumplen:

1. **Regresión**: todas las pruebas R-01 … R-20 pasan en `recordaya-dev` con el chatbot desactivado **y** activado (R-09 y R-10 describen el comportamiento con el chatbot desactivado; con el chatbot activo los reemplazan W-08 y W-01).
2. Un cliente que responde «1» citando un recordatorio confirma su turno exactamente como hoy, aunque el chatbot esté activo y haya una conversación abierta.
3. Una pregunta cubierta por la base recibe una respuesta correcta y respaldada en ≥ 90 % del set dorado (AI-01); una pregunta no cubierta **nunca** recibe datos inventados (0 alucinaciones comerciales en AI-02/AI-05 sobre 50 casos).
4. Ningún intento del set de inyección (AI-07, 30 casos) revela el prompt del sistema ni cambia las reglas.
5. La derivación funciona de punta a punta: oferta → confirmación → cola → toma → respuesta del operador entregada → devolución a IA.
6. Dos operadores que intentan tomar la misma conversación al mismo tiempo: exactamente uno lo logra (H-05).
7. Un usuario de un negocio no puede leer ni modificar nada de otro negocio por ninguna ruta (S-01 … S-06).
8. Un mismo evento de Meta reenviado 3 veces produce una sola respuesta (W-03).
9. El consumo de IA queda registrado por llamada y el tope mensual se respeta (AI-12).
10. Documentación de operación actualizada (README, `.env.example`, runbook) y checklist §27 completado.

---

## Decisiones pendientes (requieren respuesta del responsable del producto)

| ID | Decisión | Opciones | Recomendación | Bloquea |
| --- | --- | --- | --- | --- |
| D-01 | ¿Multi-negocio real o un único negocio por despliegue? | (a) multi-negocio con Supabase Auth; (b) un negocio, contraseña compartida | **(a)**: la atención humana necesita identidad por operador; además está en el roadmap ("Login multi-negocio") | Fases 3, 10 |
| D-02 | ¿Se mantiene el login por `PANEL_PASSWORD`? | (a) eliminar al migrar; (b) mantener como "modo demo" mapeado al owner del negocio por defecto | **(b)** temporal, detrás de `PANEL_LEGACY_LOGIN=true`, hasta terminar Fase 10 | T-03.x |
| D-03 | Modelo de IA por defecto | `claude-opus-5-5` (mejor calidad, ~USD 0,025/resp.), `claude-sonnet-5-5` (~0,015), `claude-haiku-5-5` (~0,001) | La especificación usa **`claude-opus-5-5` con esfuerzo `low`** como valor por defecto y permite elegir por negocio. La elección final según presupuesto es del responsable; ver §24 | T-06.x |
| D-04 | Proveedor de embeddings | Voyage AI, OpenAI, modelo local en Supabase Edge Functions | **Voyage AI** (`voyage-3.5-lite`, 1024 dimensiones, multilingüe). [PENDIENTE] confirmar precio y términos vigentes | T-05.x |
| D-05 | Cuenta y facturación de los proveedores de IA | — | Crear cuentas a nombre del responsable; claves solo en Vercel | Fase 6 |
| D-06 | Política de cancelación en modo chatbot | (a) mantener el parser actual (la primera palabra «no» cancela); (b) parser estricto fuera de respuestas citadas | **(b)**, ver [02-arquitectura.md §5.3](02-arquitectura.md#53-por-qué-un-parser-estricto-solo-con-chatbot-activo). Con el chatbot desactivado no cambia nada | T-08.2 |
| D-07 | Canal de aviso a operadores fuera del panel | Email (Resend u otro), plantilla WhatsApp al operador, ninguno | MVP: ninguno (panel + notificación del navegador) | Fase 9 |
| D-08 | Plantilla de reapertura de conversación (fuera de 24 h) | Crear y aprobar en WhatsApp Manager una plantilla *utility* `retomar_conversacion` | Crear | T-09.8 |
| D-09 | Plan de Vercel | Hobby no admite uso comercial [PENDIENTE verificar términos vigentes] | Pro si RecordaYa se comercializa | Fase 13 |
| D-10 | Retención de conversaciones y textos extraídos | 6 / 12 / 24 meses | 12 meses, configurable | T-12.6 |
| D-11 | ¿Se publica el widget web? | MVP / fase 2 / no | Fase 2 | Fase 11 |
| D-12 | Identificador del número por negocio | Hoy un solo `WHATSAPP_PHONE_NUMBER_ID` global | Guardar `businesses.wa_phone_number_id` y resolver el negocio por `metadata.phone_number_id` del webhook | T-03.1, T-08.1 |

### Registro de decisiones (T-01.1)

**2026-11-19 — el responsable del producto aprobó la columna «Recomendación» de D-01 a D-12 tal como está escrita.** Quedan estas acciones o verificaciones, que no son decisiones sino datos que aún faltan:

| ID | Decisión aprobada | Pendiente de verificar o ejecutar |
| --- | --- | --- |
| D-01 | Multi-negocio con Supabase Auth | — |
| D-02 | Mantener `PANEL_PASSWORD` como modo temporal (`PANEL_LEGACY_LOGIN=true`) hasta terminar la Fase 10 | — |
| D-03 | **Revisada 2026-11-19 (demo gratuita):** generación con **Gemini en su capa gratuita** detrás de `LlmProvider`; `claude-*` queda como adaptador opcional futuro. Pruebas automatizadas siempre con el proveedor falso | Verificar el modelo de texto gratuito vigente y sus límites al implementar T-06.2. La capa gratuita puede usar los datos para mejorar productos de Google y no está garantizada: aceptado por ser una demo con datos ficticios |
| D-04 | **Revisada 2026-11-19:** Voyage AI **`voyage-4-lite`** (200 M de tokens gratis por cuenta según su página de precios) | Confirmar que admite 1024 dimensiones (`output_dimension`); si no, ajustar la dimensión de `vector(n)` en la migración 0007 |
| D-05 | Cuentas de proveedores a nombre del responsable; claves solo en Vercel | El responsable crea la cuenta de Google AI Studio (clave Gemini) y la de Voyage, sin método de pago |
| D-06 | Parser estricto solo con el chatbot activo | — |
| D-07 | Sin aviso externo a operadores (solo panel y notificación del navegador) | — |
| D-08 | Crear la plantilla *utility* `retomar_conversacion` | El responsable la crea y espera la aprobación en WhatsApp Manager |
| D-09 | Vercel Pro si RecordaYa se comercializa | Verificar términos vigentes de Hobby |
| D-10 | Retención de 12 meses, configurable | — |
| D-11 | Widget web en fase 2 | — |
| D-12 | `businesses.wa_phone_number_id`, resolviendo el negocio por `metadata.phone_number_id` | — |

Faltan las verificaciones de T-01.1 que dependen de paneles externos: disponibilidad de `pgvector` en `recordaya-dev` y en `RecordaYA`, plan y `maxDuration` de Vercel, cupo diario de Upstash y campo suscrito en Meta (lista en [01-auditoria.md §3.9](01-auditoria.md#39-información-no-verificable-desde-el-repositorio)).

Información que **no está en el repositorio** y debe aportar el responsable: ver [01-auditoria.md §3.9](01-auditoria.md#39-información-no-verificable-desde-el-repositorio).
