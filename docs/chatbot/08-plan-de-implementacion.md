# 08 · Plan de implementación

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

Orden obligatorio: las fases respetan dependencias técnicas; dentro de cada fase, las tareas se ejecutan en el orden listado salvo que su campo *Dependencias* permita paralelizar. Cada tarea termina en un PR a `main` (Vercel despliega en cada push a `main` [HECHO]; por eso **todo código nuevo entra apagado** detrás de `CHATBOT_ENABLED=false` y `chatbot_settings.enabled=false` hasta la Fase 13).

Formato de cada tarea: **Obj.** objetivo · **Desc.** descripción · **Mod.** archivos existentes modificados · **Nuevos** · **Dep.** dependencias · **Config.** configuración · **Impl.** implementación técnica · **Resultado** · **Acept.** criterios de aceptación · **Pruebas** · **Hecho cuando**.

Regla transversal para cada PR: `npm run lint`, `npm run typecheck`, `npm test` en verde; suite de regresión R-* en verde; checklist de seguridad (07 §19.13).

---

## Fase 1 · Auditoría y preparación

### T-01.1 · Cerrar información pendiente
- **Obj.** Resolver las decisiones D-01…D-12 y los datos de [01 §3.9](01-auditoria.md#39-información-no-verificable-desde-el-repositorio).
- **Desc.** Reunión/consulta con el responsable; registrar respuestas en este documento (tabla de decisiones).
- **Mod.** `docs/chatbot/RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md`. **Nuevos** —. **Dep.** —.
- **Config.** Acceso de lectura a Meta, Vercel, Supabase, Upstash.
- **Impl.** Verificar en Supabase: `select extversion from pg_available_extensions where name='vector'`; en Vercel: plan y `maxDuration`; en Upstash: cupo diario; en Meta: campo suscrito.
- **Resultado** Tabla de decisiones completa.
- **Acept.** Ninguna decisión bloqueante queda abierta para Fases 3–9.
- **Pruebas** —. **Hecho cuando** el responsable aprueba por escrito.

### T-01.2 · Infraestructura de pruebas (Vitest)
- **Obj.** Poder escribir pruebas unitarias e de integración.
- **Desc.** Instalar Vitest y configurar alias `@/`.
- **Mod.** `package.json` (scripts `test`, `test:watch`, `typecheck: tsc --noEmit`). **Nuevos** `vitest.config.ts`, `tests/setup.ts`, `tests/helpers/supabase-test.ts`.
- **Dep.** —. **Config.** `.env.test` (ignorado) apuntando a `recordaya-dev` o a Supabase local (`supabase start`) [recomendado local].
- **Impl.** `environment: 'node'`, `resolve.alias['@'] = './src'`, mock de `server-only` (`vi.mock('server-only', () => ({}))`).
- **Resultado** `npm test` corre.
- **Acept.** Una prueba trivial de `parseReplyIntent` pasa.
- **Pruebas** Prueba de humo. **Hecho cuando** el script corre en local y CI.

### T-01.3 · Pruebas de caracterización de recordatorios
- **Obj.** Congelar el comportamiento actual antes de tocar el webhook.
- **Desc.** Implementar R-01…R-20 ([09 §22](09-plan-de-pruebas.md#22-pruebas-de-regresión)) con WhatsApp y QStash simulados.
- **Mod.** —. **Nuevos** `tests/regression/*.test.ts`, `tests/fakes/whatsapp.ts` (intercepta `fetch` a graph.facebook.com), `tests/fakes/qstash.ts`, `tests/fixtures/webhook-payloads.ts` (basado en `scripts/simulate-reply.mjs`).
- **Dep.** T-01.2. **Config.** Base de pruebas con migraciones 0001–0004.
- **Impl.** Llamar `POST` del route handler del webhook con payload firmado; esperar el `after()` (invocar `processWebhook` directamente en pruebas de integración); afirmar filas en `messages`, `inbound_messages`, `appointments` y llamadas a Graph API.
- **Resultado** Suite de regresión.
- **Acept.** 20/20 en verde sobre `main` actual sin modificaciones.
- **Pruebas** Las propias. **Hecho cuando** se ejecutan en CI.

### T-01.4 · CI en GitHub Actions
- **Obj.** Bloquear PRs que rompan lint, tipos o pruebas.
- **Nuevos** `.github/workflows/ci.yml`. **Mod.** —. **Dep.** T-01.2.
- **Config.** Secrets de CI solo si se usa base remota (preferir Supabase local con `supabase/setup-cli` y `supabase start`).
- **Impl.** Node 20, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`.
- **Resultado / Acept.** Workflow verde en un PR de prueba; protección de rama `main` exige el check [configuración en GitHub por el responsable].
- **Pruebas** PR con error de tipos falla. **Hecho cuando** la protección está activa.

### T-01.5 · Logger estructurado
- **Obj.** Logs útiles sin datos personales.
- **Nuevos** `src/lib/logger.ts` (`log.info/warn/error(scope, msg|error, ctx)`, `maskPhone`). **Mod.** — (los `console.*` existentes no se tocan). **Dep.** —.
- **Impl.** `console.log(JSON.stringify({...}))`; `maskPhone("59899123456") = "5989****456"`; nunca serializa `body`.
- **Acept.** Pruebas unitarias de enmascarado. **Hecho cuando** se usa en el módulo nuevo.

---

## Fase 2 · Diseño de arquitectura y modelo de datos

### T-02.1 · Aprobación de la especificación
- **Obj.** Congelar el diseño. **Desc.** Revisión de 01–10 y ajustes. **Mod.** `docs/chatbot/*`. **Dep.** T-01.1.
- **Acept.** Versión 1.1 aprobada. **Hecho cuando** existe aprobación escrita.

### T-02.2 · Set dorado de evaluación
- **Obj.** Tener casos para medir el motor desde el inicio.
- **Nuevos** `tests/ai-evals/fixtures/barberia.json` (20 FAQ, 3 textos, horarios), `tests/ai-evals/cases.json` (≥ 120 casos: 50 conocidas, 30 desconocidas, 10 ambiguas, 5 contradictorias, 30 inyecciones, 10 fuera de ámbito — ver AI-*).
- **Dep.** —. **Acept.** Cada caso tiene `expected` verificable automáticamente. **Hecho cuando** revisado por el responsable (tono y contenido).

---

## Fase 3 · Migraciones y servicios backend

### T-03.1 · Migraciones 0005–0011 y reversiones
- **Obj.** Crear el esquema del chatbot sin afectar datos existentes.
- **Nuevos** `supabase/migrations/0005_business_members.sql` … `0011_storage_knowledge.sql`, `supabase/migrations/down/0005.sql` … `0011.sql`. **Mod.** `README.md` (lista de migraciones).
- **Dep.** T-01.1 (pgvector disponible), T-02.1. **Config.** Ejecutar en `recordaya-dev`.
- **Impl.** SQL de [03](03-modelo-de-datos.md#migraciones-sql). Probar `up → down → up` en una base local.
- **Resultado** Tablas, índices, funciones y bucket creados en dev.
- **Acept.** `select count(*)` de tablas existentes idéntico antes/después; R-* en verde; `down` deja el esquema como antes (comparar `pg_dump --schema-only`).
- **Pruebas** `tests/db/migrations.test.ts`: existencia de objetos, `claim_conversation` concurrente (2 conexiones, 1 gana), `match_knowledge_chunks` aislada por negocio.
- **Hecho cuando** aplicado en dev y probado ida y vuelta.

### T-03.2 · Supabase Auth (cliente servidor y callback)
- **Obj.** Identidad de usuarios del panel.
- **Nuevos** `src/lib/auth/supabase-server.ts`, `src/app/auth/callback/route.ts`. **Mod.** `package.json` (`@supabase/ssr`), `.env.example`.
- **Dep.** T-03.1. **Config.** Supabase Auth: email/contraseña habilitado, registro deshabilitado, URL de sitio y *redirect URLs* (`/auth/callback`) para dev y prod; plantilla de email de invitación en español.
- **Impl.** `createServerClient(url, publishableKey, { cookies: { getAll, setAll } })` con `cookies()` de Next; callback hace `exchangeCodeForSession` y redirige a `/panel` o a "definir contraseña". Leer guía de Next en `node_modules/next/dist/docs` sobre cookies en Route Handlers/Server Actions.
- **Acept.** Un usuario invitado define contraseña e inicia sesión en dev.
- **Pruebas** Integración del callback con código inválido → redirección a `/login?error`. **Hecho cuando** el flujo funciona en dev.

### T-03.3 · Sesión de miembro, permisos y proxy
- **Obj.** `requireMember(rol)` disponible para todo el panel, con compatibilidad legacy.
- **Nuevos** `src/lib/auth/session.ts`, `src/lib/auth/permissions.ts`. **Mod.** `src/proxy.ts` (acepta sesión Supabase o cookie `ry_panel` si `PANEL_LEGACY_LOGIN=true`), `src/lib/panel/auth.ts` (`requirePanelSession` delega en `requireMember('operator')`), `src/app/login/actions.ts` y `login-form.tsx` (email + contraseña; campo único de contraseña si legacy), `src/app/panel/layout.tsx` (logout de ambos).
- **Dep.** T-03.2. **Config.** `PANEL_LEGACY_LOGIN=true`.
- **Impl.** Ver [06 §3.1](06-apis-e-interfaz.md#31-integración-con-la-autenticación-actual). Miembro activo = fila `business_members` con `user_id = auth.uid()` y `status='active'`; varios negocios ⇒ cookie `ry_business` validada contra membresías.
- **Resultado** Todas las páginas actuales siguen funcionando con login legacy y con usuarios.
- **Acept.** R-15 (acceso al panel) en verde con ambos modos; usuario sin membresía → 403.
- **Pruebas** Unitarias de `can()`; integración de `requireMember` con 3 roles. **Hecho cuando** desplegado con legacy activo sin cambios visibles.

### T-03.4 · Servicio de miembros
- **Obj.** Invitar, cambiar rol, desactivar, disponibilidad.
- **Nuevos** `src/lib/auth/members.ts`. **Dep.** T-03.3.
- **Impl.** `inviteMember` usa `supabase.auth.admin.inviteUserByEmail` con la clave secreta + fila `invited`; al primer login, enlazar `user_id` y `status='active'`; reglas: no eliminar/degradar al último `owner`; desactivar ⇒ liberar conversaciones `human` (T-09.3); auditoría.
- **Acept.** Reglas cubiertas por pruebas. **Pruebas** Unitarias + integración. **Hecho cuando** las acciones de T-10.6 pueden usarlo.

### T-03.5 · Publicación de jobs y configuración del módulo
- **Obj.** Encolar jobs nuevos sin tocar `scheduleReminder`.
- **Mod.** `src/lib/scheduler/qstash.ts` (+ `publishJob(path, body, {delaySeconds?, deduplicationId?, retries?})`), `.env.example`. **Nuevos** `src/lib/chatbot/config.ts` (lectura de env, lista blanca de modelos, `isChatbotGloballyEnabled()`), `src/lib/chatbot/jobs.ts`.
- **Dep.** —. **Impl.** `getClient().publishJSON({ url: getAppUrl()+path, body, delay, deduplicationId, retries, label })`.
- **Acept.** `scheduleReminder` sin diff; prueba con QStash dev publica y el handler recibe firma válida.
- **Pruebas** Unitaria con cliente QStash simulado. **Hecho cuando** fusionado.

---

## Fase 4 · Configuración del chatbot

### T-04.1 · Servicio de configuración
- **Nuevos** `src/lib/chatbot/settings.ts` (`SettingsSchema` Zod espejo de la tabla, `getChatbotSettings(businessId)`, `upsertChatbotSettings(businessId, patch, member)`, `renderTemplate(msg, vars)`).
- **Obj.** Leer/guardar configuración validada. **Dep.** T-03.1, T-03.3.
- **Impl.** Defaults de la migración; `llm_model` validado contra lista blanca; `human_hours` validado (`HH:MM`, inicio < fin, sin solapes); diff a `audit_log`.
- **Acept.** Configuración inválida → `ServiceError` con mensaje legible. **Pruebas** Unitarias del esquema y `renderTemplate`. **Hecho cuando** fusionado.

### T-04.2 · Horarios humanos
- **Nuevos** `src/lib/chatbot/conversations/hours.ts` (`isWithinHumanHours(hours, tz, now)`, `nextOpening(hours, tz, now)`, `describeNextOpening(date, tz, now)` → «hoy a las 15:00» / «mañana a las 9:00» / «el lunes 24 a las 9:00»).
- **Dep.** T-04.1. **Impl.** Reutilizar `dayKey`, `zonedToUtc`, `formatHora`, `formatFecha` de `dates.ts`.
- **Acept.** Correcto en cambios de día, excepciones y zona `America/Montevideo`. **Pruebas** ≥ 15 casos unitarios. **Hecho cuando** fusionado.

### T-04.3 · UI de configuración
- **Nuevos** `src/app/panel/chatbot/page.tsx`, `src/app/panel/chatbot/actions.ts`, `src/app/panel/chatbot/settings-form.tsx`, `src/app/panel/chatbot/hours-editor.tsx`. **Mod.** —(la nav se agrega en T-10.2).
- **Dep.** T-04.1, T-04.2. **Impl.** Ver [06 §18.5](06-apis-e-interfaz.md#185-chatbot--panelchatbot) pestañas 1–6; página con `Suspense` + `requireMember('admin')`; formularios con `useActionState` (patrón de `new-appointment.tsx`).
- **Acept.** Guardar/recargar conserva valores; operator recibe 403; owner ve pestaña IA. **Pruebas** Integración de acciones (permisos y validación). **Hecho cuando** usable en dev.

---

## Fase 5 · Base de conocimiento y RAG

### T-05.1 · Servicio de fuentes y versiones
- **Nuevos** `src/lib/chatbot/rag/sources.ts`. **Dep.** T-03.1, T-03.5.
- **Impl.** `createSource`, `updateSource` (metadatos sin versión; contenido ⇒ `newVersion`), `newVersion` (`version = max+1`, `status pending`), `setEnabled`, `softDelete` (borra chunks, `deleted_at`), `listSources`, `getSource` — todas con `businessId`.
- **Acept.** Una nueva versión no altera `active_document_id` hasta `ready`. **Pruebas** Integración. **Hecho cuando** fusionado.

### T-05.2 · Flujo de subida de archivos
- **Nuevos** acciones `requestUploadAction`, `confirmUploadAction` en `src/app/panel/conocimiento/actions.ts`; `src/lib/chatbot/rag/storage.ts`.
- **Dep.** T-05.1, migración 0011. **Config.** Bucket `knowledge`.
- **Impl.** `storage.from('knowledge').createSignedUploadUrl(path)`; en cliente `uploadToSignedUrl`; `confirm` verifica `list()`/metadata tamaño ≤ límite; borra el objeto si no valida.
- **Acept.** Archivo de 11 MB rechazado; ruta siempre con prefijo del negocio. **Pruebas** Integración con Storage local. **Hecho cuando** fusionado.

### T-05.3 · Extractores
- **Nuevos** `src/lib/chatbot/rag/extract/{index,pdf,docx,txt,url,ssrf}.ts`. **Mod.** `package.json` (`unpdf`, `mammoth`, `linkedom`, `@mozilla/readability`).
- **Dep.** —. **Impl.** Ver [04 §15.2](04-motor-ia-y-rag.md#152-extracción). `ssrf.ts`: `dns.lookup(host, {all:true})` y rechazo de rangos privados (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10).
- **Acept.** Fixtures: PDF con texto, PDF escaneado (falla con mensaje), DOCX, TXT latin1, HTML, URL a `127.0.0.1` rechazada. Bundle desplegable en Vercel (prueba de humo en Preview).
- **Pruebas** Unitarias con `tests/fixtures/docs/*`. **Hecho cuando** la prueba de humo en Preview pasa.

### T-05.4 · Normalización y fragmentación
- **Nuevos** `src/lib/chatbot/rag/normalize.ts`, `chunk.ts`. **Dep.** —.
- **Impl.** Ver [04 §15.3–15.4](04-motor-ia-y-rag.md#153-normalización).
- **Acept.** Ningún fragmento > 800 tokens estimados; solapamiento ~15 %; FAQ = 1 fragmento. **Pruebas** Unitarias + propiedad (concatenar fragmentos sin solape reconstruye el texto). **Hecho cuando** fusionado.

### T-05.5 · Job de ingesta
- **Nuevos** `src/lib/chatbot/rag/ingest.ts`, `src/app/api/jobs/knowledge-ingest/route.ts`.
- **Dep.** T-05.1–T-05.4, T-06.3. **Config.** `maxDuration`.
- **Impl.** `ingestDocument(documentId)`: marcar `processing`; obtener contenido (fuente/Storage/URL); checksum; extraer; normalizar; fragmentar; embeber por lotes; insertar; activar versión y purgar fragmentos anteriores en una sola transacción (RPC `activate_knowledge_document(doc_id)`, definida en 0007); registrar uso. Errores permanentes ⇒ `failed` + `last_error` legible; transitorios ⇒ 500.
- **Acept.** Reprocesar el mismo archivo no duplica fragmentos; fallo deja la versión anterior respondiendo.
- **Pruebas** Integración con `FakeEmbeddingProvider`. **Hecho cuando** una FAQ y un PDF quedan `ready` en dev.

### T-05.6 · Recuperación
- **Nuevos** `src/lib/chatbot/rag/retrieve.ts`. **Dep.** T-05.5, T-06.3.
- **Impl.** Ver [04 §15.6](04-motor-ia-y-rag.md#156-recuperación).
- **Acept.** Con el fixture barbería, las 50 preguntas conocidas tienen el fragmento correcto en el top-5 en ≥ 90 %. **Pruebas** `tests/ai-evals/retrieval.test.ts` (embeddings reales, manual). **Hecho cuando** se alcanza el umbral.

### T-05.7 · UI de conocimiento
- **Nuevos** `src/app/panel/conocimiento/page.tsx`, `[id]/page.tsx`, `actions.ts` (resto de acciones), `source-form.tsx`, `upload-dropzone.tsx`, `unanswered-list.tsx`.
- **Dep.** T-05.1, T-05.2, T-05.5. **Impl.** Ver [06 §18.4](06-apis-e-interfaz.md#184-conocimiento--panelconocimiento).
- **Acept.** CRUD completo, estados visibles, error legible y reintento. **Pruebas** Integración de acciones (permisos, aislamiento). **Hecho cuando** usable en dev.

---

## Fase 6 · Integración con proveedor de IA

### T-06.1 · Interfaces, registro y proveedor falso
- **Nuevos** `src/lib/chatbot/providers/{types,registry,fake}.ts`. **Mod.** `eslint.config.mjs` (regla `no-restricted-imports` para los SDK fuera de `providers/`).
- **Dep.** —. **Acept.** El resto del módulo compila contra las interfaces. **Pruebas** Unitarias del registro. **Hecho cuando** fusionado.

### T-06.2 · Adaptador del proveedor de generación (Gemini, capa gratuita; D-03 revisada)
> Nota: el detalle de esta tarea se escribió para Anthropic. Con D-03 revisada, el adaptador es `providers/gemini.ts` con salida JSON estructurada y la misma interfaz; `anthropic.ts` queda fuera del alcance actual.
- **Nuevos** `src/lib/chatbot/providers/anthropic.ts`. **Mod.** `package.json` (`@anthropic-ai/sdk`, `zod`).
- **Dep.** T-06.1, D-03, D-05. **Config.** `ANTHROPIC_API_KEY` (dev), límite de gasto en la consola del proveedor.
- **Impl.** Ver [04 §1.3](04-motor-ia-y-rag.md#13-capa-de-abstracción). Verificar con la documentación del SDK: `messages.parse` + `zodOutputFormat`, `output_config.effort`, `cache_control`, manejo de `stop_reason === "refusal"`, *fallbacks* del servidor, clases de error. Mapear `usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`).
- **Acept.** Una llamada real en dev devuelve un objeto validado; `cache_read_input_tokens > 0` en la segunda llamada con el mismo sistema (si supera el mínimo cacheable).
- **Pruebas** Unitarias con cliente simulado (mapeo de errores, refusal); prueba manual con clave real. **Hecho cuando** fusionado.

### T-06.3 · Adaptador de embeddings (Voyage `voyage-4-lite`; D-04 revisada)
- **Nuevos** `src/lib/chatbot/providers/voyage.ts`. **Dep.** T-06.1, D-04. **Config.** `VOYAGE_API_KEY`, `EMBEDDINGS_*`.
- **Impl.** `embed(texts, kind)` con `input_type` `query`/`document`, `output_dimension: 1024`, lotes ≤ 64, reintentos 429/5xx (3, exponencial), validación de longitud de vector.
- **Acept.** Vectores de 1024; error claro si cambia la dimensión. **Pruebas** Unitarias con `fetch` simulado. **Hecho cuando** fusionado.

### T-06.4 · Medición de uso y topes
- **Nuevos** `src/lib/chatbot/usage/{pricing,meter,budget}.ts`.
- **Dep.** T-03.1. **Impl.** `pricing.ts`: tabla por modelo (entrada, salida, lectura/escritura de caché) — valores de [10 §24.1](10-despliegue-costos-riesgos.md#241-precios-unitarios-usados); `recordUsage` inserta `chatbot_usage`; `assertBudget` suma el mes en curso (zona del negocio) + diario global.
- **Acept.** Costo calculado coincide con fórmula en pruebas; tope respetado. **Pruebas** Unitarias + AI-12. **Hecho cuando** fusionado.

---

## Fase 7 · Motor conversacional

### T-07.1 · Construcción del prompt
- **Nuevos** `src/lib/chatbot/engine/prompt.ts`. **Dep.** T-04.1.
- **Impl.** Ver [04 §14.2](04-motor-ia-y-rag.md#142-prompt-del-sistema-estructura): `buildSystem(settings, business)` determinista (sin fechas), `buildContext(chunks, businessData)`, `buildHistory(messages)`, escape de `<`/`>`.
- **Acept.** Mismo input ⇒ mismo `system` byte a byte (snapshot). **Pruebas** Snapshots + escape. **Hecho cuando** fusionado.

### T-07.2 · Esquema de salida y guardas
- **Nuevos** `engine/schema.ts`, `engine/guardrails.ts` (`assertFactsInSources`, `detectPromptLeak`, `detectInjectionAttempt`, `clampAnswer`). **Dep.** T-07.1.
- **Acept.** Precio inventado en `answer` ⇒ rechazado; canario ⇒ rechazado. **Pruebas** ≥ 25 casos unitarios. **Hecho cuando** fusionado.

### T-07.3 · Respuestas sin IA
- **Nuevos** `engine/smalltalk.ts` (saludo, gracias, despedida, contenido no textual). **Dep.** T-04.1.
- **Acept.** «hola», «gracias!!», «👍» no llaman a la IA. **Pruebas** Unitarias. **Hecho cuando** fusionado.

### T-07.4 · Orquestador `runChatbotTurn`
- **Nuevos** `engine/orchestrator.ts`. **Dep.** T-05.6, T-06.*, T-07.1–T-07.3, T-08.3 (servicio de conversaciones; puede desarrollarse en paralelo con un repositorio en memoria).
- **Impl.** Pasos de [04 §14.1](04-motor-ia-y-rag.md#141-entrada-de-un-turno) y tabla §14.4. *Lease* con las RPC `try_lock_conversation` / `unlock_conversation` (definidas en 0008; no se usan *advisory locks* porque cada RPC es una transacción distinta). Fila de respuesta insertada con `status='queued'` **antes** de enviar (idempotencia por índice único), actualizada tras el envío. `dryRun` para la zona de pruebas.
- **Acept.** Con proveedor falso, todos los caminos de la tabla de decisión producen la acción y registros esperados.
- **Pruebas** `tests/engine/orchestrator.test.ts` (≥ 20 casos). **Hecho cuando** fusionado.

### T-07.5 · Resumen para el operador
- **Nuevos** `engine/summarize.ts`. **Dep.** T-06.2. **Impl.** Llamada con esfuerzo `low`, salida `{summary: string ≤ 600}`; disparada al pasar a `pending_human` (encolada, no bloquea).
- **Acept.** Resumen en español sin datos inventados (revisión manual de 10 casos). **Hecho cuando** fusionado.

### T-07.6 · Zona de pruebas
- **Nuevos** `src/app/panel/chatbot/pruebas/page.tsx`, `playground.tsx`; acción `testChatbotAction`. **Dep.** T-07.4.
- **Acept.** Muestra respuesta, fragmentos, JSON y costo; uso registrado como `playground`. **Hecho cuando** usable en dev.

### T-07.7 · Ejecutor de evaluaciones
- **Nuevos** `scripts/eval-chatbot.mjs` o `tests/ai-evals/run.ts`, script `eval:chatbot`. **Dep.** T-02.2, T-07.4.
- **Impl.** Carga fixture en un negocio de prueba, corre los casos con el proveedor real, reporta métricas y costo en `tests/ai-evals/reports/<fecha>.md` (ignorado por git o versionado, a criterio).
- **Acept.** Reporte generado. **Hecho cuando** se ejecuta y cumple umbrales de [09 §AI](09-plan-de-pruebas.md#pruebas-de-ia).

---

## Fase 8 · Integración con WhatsApp

### T-08.1 · Tipos del webhook y resolución de negocio
- **Mod.** `src/lib/whatsapp/webhook.ts` (sin cambios de lógica; tipos ya cubren `metadata`, `contacts`, `interactive.button_reply.id`) [verificar], `src/lib/whatsapp/process-webhook.ts` (pasar `metadata` y `contacts` a `saveIncoming`). **Nuevos** `src/lib/chatbot/business-resolver.ts`.
- **Dep.** T-03.1. **Config.** `update businesses set wa_phone_number_id = '<WHATSAPP_PHONE_NUMBER_ID>' where id = '<negocio>'` (dato, en dev y luego prod).
- **Acept.** Payload con `phone_number_id` desconocido ⇒ ruta legacy. **Pruebas** Unitarias. **Hecho cuando** fusionado.

### T-08.2 · Parser estricto
- **Nuevos** `src/lib/chatbot/strict-intent.ts`. **Dep.** D-06.
- **Acept.** Tabla de ejemplos de [02 §5.1](02-arquitectura.md#51-reglas-evaluadas-en-orden-la-primera-que-aplica-gana) (≥ 30 casos). `intent.ts` sin diff. **Hecho cuando** fusionado.

### T-08.3 · Servicio de conversaciones
- **Nuevos** `src/lib/chatbot/conversations/{contacts,service,events}.ts`. **Dep.** T-03.1.
- **Impl.** `upsertContact` (enlaza `customer_id` si existe `customers(business_id, phone)`), `getOrOpenConversation` (maneja carrera con el índice único parcial: `insert … on conflict do nothing` y re-select), `appendInbound` (idempotente por `inbound_message_id`), `appendOutbound`, `listMessages`, `logEvent`.
- **Acept.** Dos entrantes simultáneos del mismo contacto ⇒ una sola conversación. **Pruebas** Integración concurrente. **Hecho cuando** fusionado.

### T-08.4 · Router y cambio en `saveIncoming`
- **Nuevos** `src/lib/chatbot/router.ts`. **Mod.** `src/lib/whatsapp/process-webhook.ts` (llamada a `routeInboundMessage` en lugar de `handleCustomerReply`, ver diff en [02 §5.2](02-arquitectura.md#52-pseudocódigo-del-router)).
- **Dep.** T-08.1–T-08.3, T-03.5. **Config.** `CHATBOT_ENABLED=false` en todos los entornos al fusionar.
- **Impl.** Reglas 0–5; en ruta 0 con conversación abierta del contacto, además agregar el entrante a la conversación (05 §16.11). Errores del router en rutas ≠ legacy: registrar y **caer a legacy** (nunca perder la lógica de recordatorios).
- **Acept.** R-01…R-20 en verde con chatbot desactivado **y** activado; casos de [02 §5.4](02-arquitectura.md#54-casos-límite) cubiertos.
- **Pruebas** `tests/chatbot/router.test.ts` (≥ 25 casos), W-07…W-10. **Hecho cuando** fusionado con el interruptor apagado.

### T-08.5 · Estados de mensajes del chatbot
- **Mod.** `src/lib/whatsapp/process-webhook.ts → applyStatus` (si no está en `messages`, buscar `conversation_messages.wa_message_id` y aplicar el mismo ranking y columnas). **Dep.** T-08.3.
- **Acept.** R-04 (estados de recordatorios) intacta; mensajes del bot pasan a `read`. **Pruebas** Integración. **Hecho cuando** fusionado.

### T-08.6 · Envío por canal y botones
- **Mod.** `src/lib/whatsapp/client.ts` (+ `sendInteractiveButtons(to, body, buttons)` reutilizando `postMessage`). **Nuevos** `src/lib/chatbot/channels/{types,whatsapp}.ts` (`ChannelSender.sendText/sendButtons`, controla ventana 24 h, mapea errores a permanentes/transitorios).
- **Dep.** —. **Acept.** `sendTemplate`/`sendText` sin diff de comportamiento. **Pruebas** Unitarias con `fetch` simulado (payload exacto). **Hecho cuando** probado con el número de prueba de Meta en dev.

### T-08.7 · Job `chatbot-reply`
- **Nuevos** `src/app/api/jobs/chatbot-reply/route.ts`. **Dep.** T-07.4, T-08.6.
- **Impl.** Ver [06 §13.1](06-apis-e-interfaz.md#contrato-del-job-chatbot-reply).
- **Acept.** W-01…W-06. **Pruebas** Integración con QStash dev. **Hecho cuando** fusionado.

### T-08.8 · Simulación local
- **Mod.** `scripts/simulate-reply.mjs` (+ opciones `--context <wamid>`, `--button <id>`, `--type audio`, `--phone-number-id`). **Dep.** T-08.4.
- **Acept.** Se pueden reproducir todos los casos de [02 §5.4](02-arquitectura.md#54-casos-límite) en local. **Hecho cuando** documentado en README.

---

## Fase 9 · Derivación y atención humana

### T-09.1 · Máquina de estados
- **Nuevos** `src/lib/chatbot/conversations/state-machine.ts` (`TRANSITIONS`, `transition(conv, to, actor, expectedVersion)`). **Dep.** T-08.3.
- **Acept.** Transiciones no listadas ⇒ 409; versión desfasada ⇒ 409. **Pruebas** Tabla completa T1–T12 + inválidas. **Hecho cuando** fusionado.

### T-09.2 · Oferta, aceptación y rechazo
- **Nuevos** `conversations/handoff.ts` (`offerHandoff`, `acceptHandoff`, `declineHandoff`, `handleHandoffButton`). **Dep.** T-09.1, T-08.6, T-04.2.
- **Acept.** H-01…H-03, H-08. **Hecho cuando** fusionado.

### T-09.3 · Acciones del operador
- **Nuevos** `src/app/panel/conversaciones/actions.ts` (claim, release, returnToBot, resolve, close, handoff, markRead). **Dep.** T-09.1, T-03.3.
- **Acept.** H-04…H-07, H-10. **Pruebas** Integración por acción con permisos. **Hecho cuando** fusionado.

### T-09.4 · Reasignación
- **Mod.** migración nueva `0012_reassign_conversation.sql` (función atómica) o incluirla en 0008 si aún no se aplicó en producción. **Dep.** T-09.3.
- **Acept.** Reasignar no deja dos asignaciones abiertas (índice único). **Hecho cuando** fusionado.

### T-09.5 · Mensajes del operador
- **Impl.** `sendAgentMessageAction` con inserción condicionada + `client_request_id` + `sendText`; registra `first_response_at` humano. **Dep.** T-09.3, T-08.6.
- **Acept.** H-05 (concurrencia), H-09 (ventana 24 h). **Hecho cuando** fusionado.

### T-09.6 · Aviso fuera de horario
- **Impl.** En router regla 4 y en `acceptHandoff`; frecuencia máxima 12 h. **Dep.** T-04.2. **Acept.** H-06. **Hecho cuando** fusionado.

### T-09.7 · Job de mantenimiento
- **Nuevos** `src/app/api/jobs/conversations-maintenance/route.ts`, `src/lib/chatbot/conversations/maintenance.ts`. **Dep.** T-09.1.
- **Config.** Schedule de QStash cada 10 min (`*/10 * * * *`) [verificar cupo, RI-09].
- **Impl.** T9, T11; disponibilidad por `last_seen_at`; re-encolar entrantes `bot` sin respuesta > 2 min (máx. 20 por corrida); retención (T-12.6).
- **Acept.** Idempotente (dos corridas seguidas no cambian nada en la segunda). **Hecho cuando** fusionado.

### T-09.8 · Plantilla de reapertura (D-08)
- **Config.** Crear plantilla *utility* en WhatsApp Manager (p. ej. «Hola {{1}}, te escribimos de {{2}} por tu consulta. Responde a este mensaje para continuar.») y esperar aprobación. **Mod.** `src/lib/whatsapp/templates.ts` (+ entrada `retomarConversacion` y builder). **Dep.** T-09.5.
- **Acept.** Solo disponible si `WHATSAPP_REOPEN_TEMPLATE` está definida. **Hecho cuando** aprobada y probada.

---

## Fase 10 · Panel administrativo

### T-10.1 · Acotar el panel actual por negocio
- **Mod.** `src/lib/panel/data.ts` (todas las consultas reciben `businessId` y filtran), `src/app/panel/page.tsx`, `src/app/panel/turnos/[id]/page.tsx`, `src/app/panel/actions.ts` (validar que el turno/negocio pertenece al miembro; `createAppointmentAction` usa el negocio de la sesión en lugar del `select`).
- **Dep.** T-03.3. **Riesgo** Regresión visible del panel. **Mitigación** Con un solo negocio el resultado es idéntico; pruebas R-15…R-18.
- **Acept.** Un miembro del negocio B no ve turnos de A (S-01). **Hecho cuando** fusionado y verificado en dev con 2 negocios.

### T-10.2 · Navegación y disponibilidad
- **Mod.** `src/app/panel/layout.tsx`. **Nuevos** `src/app/panel/nav.tsx` (Client Component: badge por polling, interruptor Disponible), `src/app/api/panel/inbox/route.ts` (contadores).
- **Dep.** T-03.3. **Acept.** Ítems según rol; badge se actualiza en ≤ 10 s. **Hecho cuando** fusionado.

### T-10.3 · Bandeja
- **Nuevos** `src/app/panel/conversaciones/page.tsx`, `inbox-list.tsx`, `src/lib/chatbot/panel-data.ts` (consultas de bandeja con búsqueda y filtros). **Dep.** T-10.2, T-08.3.
- **Acept.** Filtros y búsqueda correctos; paginación por cursor. **Hecho cuando** usable en dev.

### T-10.4 · Detalle de conversación
- **Nuevos** `src/app/panel/conversaciones/[id]/page.tsx`, `conversation-timeline.tsx`, `composer.tsx`, `contact-panel.tsx`, `src/app/api/panel/conversations/[id]/messages/route.ts`. **Dep.** T-09.3, T-09.5.
- **Impl.** Línea de tiempo unificada (incluye `messages` del teléfono y negocio), reutilizar `MessageTicks`.
- **Acept.** H-04 (historial completo, motivo visible). **Hecho cuando** usable en dev.

### T-10.5 · Métricas
- **Nuevos** `src/app/panel/chatbot/metricas/page.tsx`; consultas en `panel-data.ts`. **Dep.** T-06.4, T-10.3.
- **Acept.** Valores coinciden con consultas SQL de control sobre datos semilla. **Hecho cuando** fusionado.

### T-10.6 · Equipo
- **Nuevos** `src/app/panel/equipo/{page,actions,member-form}.tsx`. **Dep.** T-03.4.
- **Acept.** Invitación llega por email en dev; reglas de último owner. **Hecho cuando** fusionado.

### T-10.7 · Preguntas sin respuesta
- **Impl.** Lista en `/panel/conocimiento` con agrupación por similitud trigram (`pg_trgm` [PENDIENTE habilitar] o agrupación en memoria por normalización simple), "Crear FAQ" prellenado, "Ignorar". **Dep.** T-05.7.
- **Acept.** Crear FAQ marca la pregunta `resolved` con `resolved_source_id`. **Hecho cuando** fusionado.

---

## Fase 11 · Widget web (solo si D-11 lo aprueba)

| ID | Tarea | Nuevos | Acept. |
| --- | --- | --- | --- |
| T-11.1 | Claves públicas y orígenes en configuración | campos en pestaña General | Rotación de clave invalida sesiones |
| T-11.2 | Endpoints `/api/widget/v1/*` + token firmado + rate limit | `src/app/api/widget/v1/**`, `channels/web.ts` | S-10 (origen no permitido ⇒ 403) |
| T-11.3 | Página iframe `/widget/[key]` + script `public/widget/v1.js` | UI accesible, ≤ 20 KB | Funciona en página de prueba externa |
| T-11.4 | Bandeja: canal Web, sin ventana 24 h | ajustes en T-10.3/10.4 | Operador responde y el widget lo recibe en ≤ 5 s |

---

## Fase 12 · Seguridad y pruebas

| ID | Tarea | Detalle | Hecho cuando |
| --- | --- | --- | --- |
| T-12.1 | Pruebas de seguridad automatizadas | S-01…S-09 en `tests/security/` | Todas en verde en CI |
| T-12.2 | Evaluación y ajuste de IA | Correr `eval:chatbot`; ajustar umbrales/prompt; registrar versión del prompt (`PROMPT_VERSION` en `prompt.ts`) | Cumple umbrales AI-* |
| T-12.3 | Pruebas de WhatsApp | W-01…W-12 con simulador y con número de prueba de Meta | Todas en verde |
| T-12.4 | Rate limits y presupuestos | Implementar/verificar límites de 07 §19.10 | AI-12, W-11 en verde |
| T-12.5 | Revisión de seguridad | Checklist 07 §19.13 sobre todos los PRs; `npm audit`; revisión manual de endpoints | Sin hallazgos altos abiertos |
| T-12.6 | Retención y borrado | Purga en mantenimiento (`webhook_events` 30 d, conversaciones 12 m); acción "Borrar datos de este contacto" | S-09 en verde |

---

## Fase 13 · Despliegue y puesta en producción

| ID | Tarea | Detalle | Hecho cuando |
| --- | --- | --- | --- |
| T-13.1 | Respaldo y migraciones en producción | Respaldo (§23.2), aplicar 0005–0011 en `RecordaYA`, verificar conteos | Conteos de tablas existentes idénticos |
| T-13.2 | Variables y cuentas | Cargar env de 06 §13.4 en Vercel Production; límites de gasto en consolas de IA; Supabase Auth URLs de prod | Deploy sin `ConfigError` |
| T-13.3 | Lanzamiento oscuro | Deploy con `CHATBOT_ENABLED=false`; correr R-* en producción (con números de prueba) | 48 h sin incidentes en recordatorios |
| T-13.4 | Legal | Actualizar `/privacidad` (IA, proveedores, retención) | Publicado |
| T-13.5 | Piloto | `CHATBOT_ENABLED=true`, `chatbot_settings.enabled=true` solo en el negocio piloto; schedule de mantenimiento en QStash; operadores invitados | 1 semana con métricas dentro de umbrales (§23.4) |
| T-13.6 | Apertura | Habilitar a demás negocios (si D-01) | Checklist §27 completo |

---

## Fase 14 · Monitoreo y documentación final

| ID | Tarea | Detalle | Hecho cuando |
| --- | --- | --- | --- |
| T-14.1 | Monitoreo | Consultas SQL guardadas (§23.5), alertas de Vercel Log Drains o revisión diaria; alerta de presupuesto al 80 % | Runbook con consultas |
| T-14.2 | Documentación | README (secciones Chatbot, Conocimiento, Equipo, variables, scripts), `.env.example`, `docs/chatbot/RUNBOOK.md` (activar/desactivar, rotar claves, reprocesar, revertir) | Revisado por el responsable |
| T-14.3 | Revisión post-lanzamiento | A las 2 semanas: costo real vs estimado, tasa de derivación, preguntas sin respuesta top-20, ajustes | Informe entregado |

---

## Resumen de archivos existentes modificados

| Archivo | Tarea | Cambio | Riesgo de regresión |
| --- | --- | --- | --- |
| `package.json` | T-01.2, T-03.2, T-05.3, T-06.2 | Scripts y dependencias | Bajo |
| `eslint.config.mjs` | T-06.1 | Regla de imports | Bajo |
| `.env.example`, `README.md` | varias | Documentación | Nulo |
| `src/lib/scheduler/qstash.ts` | T-03.5 | + `publishJob` | Bajo (función nueva) |
| `src/proxy.ts` | T-03.3 | Acepta sesión Supabase | **Medio**: acceso al panel |
| `src/lib/panel/auth.ts` | T-03.3 | Delegación a `requireMember` | **Medio** |
| `src/app/login/actions.ts`, `login-form.tsx` | T-03.3 | Email + contraseña / legacy | **Medio** |
| `src/app/panel/layout.tsx` | T-03.3, T-10.2 | Nav y logout | Bajo |
| `src/lib/panel/data.ts`, `src/app/panel/page.tsx`, `turnos/[id]/page.tsx`, `panel/actions.ts` | T-10.1 | Filtro por negocio | **Medio** |
| `src/lib/whatsapp/webhook.ts` | T-08.1 | Tipos | Nulo |
| `src/lib/whatsapp/process-webhook.ts` | T-08.1, T-08.4, T-08.5 | Router + estados | **Alto**: camino de respuestas a recordatorios ⇒ suite R-* obligatoria |
| `src/lib/whatsapp/client.ts` | T-08.6 | + `sendInteractiveButtons` | Bajo |
| `src/lib/whatsapp/templates.ts` | T-09.8 | + plantilla | Nulo |
| `scripts/simulate-reply.mjs` | T-08.8 | Opciones nuevas | Nulo |

Sin cambios: `src/lib/appointments/*`, `src/app/api/jobs/send-reminder`, `src/app/api/jobs/dispatch`, `src/app/api/appointments/*`, `src/app/api/messages/test`, `src/lib/dates.ts`, `src/lib/env.ts`, migraciones 0001–0004.
