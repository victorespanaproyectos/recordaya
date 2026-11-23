# 10 · Despliegue, costos, riesgos y checklist

[← Índice](RECORDAYA_CHATBOT_TECHNICAL_SPECIFICATION.md)

---

## 23. Despliegue

### 23.1 Entornos [HECHO por README]

| | Local | Preview (Vercel) | Producción |
| --- | --- | --- | --- |
| Supabase | `recordaya-dev` o local | `recordaya-dev` | `RecordaYA` |
| QStash | Dev local (`QSTASH_DEV=true`) | Upstash | Upstash |
| Webhook de Meta | Simulado | Simulado | Real (único webhook) |
| `CHATBOT_ENABLED` | true | true | false hasta T-13.5 |

### 23.2 Procedimiento de migración en producción

1. Ventana de baja actividad (fuera de horarios con recordatorios cercanos; consultar `select min(scheduled_for) from messages where status='queued' and scheduled_for > now()`).
2. **Respaldo**: `pg_dump` de `RecordaYA` (o respaldo del plan) guardado en `backups/` (ignorado por git [HECHO]) — contiene datos personales: almacenar cifrado y borrar a los 30 días.
3. Conteos de control: `select 'appointments', count(*) from appointments union all …` para las 6 tablas existentes.
4. Aplicar `0005` → `0011` en orden (SQL Editor o `supabase db push`, según T-01.1).
5. Repetir conteos: deben ser idénticos.
6. `update businesses set wa_phone_number_id = '<id>' where id = '<negocio>'`.
7. Deploy de la versión con `CHATBOT_ENABLED=false`.
8. Prueba de humo: R-13, R-15 y un turno de prueba con un número del equipo (R-01, R-06).

### 23.3 Activación gradual

| Paso | Acción | Criterio para avanzar |
| --- | --- | --- |
| 1 | Lanzamiento oscuro (48 h) | Sin errores nuevos en logs del webhook; recordatorios normales |
| 2 | `CHATBOT_ENABLED=true`, negocio piloto con `enabled=true`, solo con teléfonos del equipo (opcional: lista blanca `CHATBOT_ALLOWLIST_PHONES` durante 48 h) | W-01…W-15 manuales OK en producción |
| 3 | Piloto abierto a clientes reales (1 semana) | Umbrales §23.4 |
| 4 | Demás negocios | Checklist §27 |

### 23.4 Umbrales del piloto

- Errores del job `chatbot-reply` < 2 % de ejecuciones.
- p90 de respuesta < 12 s.
- 0 casos de turnos cancelados/confirmados por error (revisión de `reminder_reply_routed`).
- Costo diario dentro del ±50 % de la estimación.
- Tasa de derivación < 40 % (si es mayor, falta conocimiento: revisar preguntas sin respuesta).

### 23.5 Monitoreo (consultas guardadas)

```sql
-- Entrantes de conversaciones bot sin respuesta > 2 min (debería ser 0)
select c.business_id, m.id, m.created_at from conversation_messages m
join conversations c on c.id = m.conversation_id
where m.direction = 'inbound' and c.status = 'bot' and m.created_at < now() - interval '2 minutes'
  and not exists (select 1 from conversation_messages r where r.reply_to_message_id = m.id);

-- Costo del día por negocio
select business_id, sum(cost_usd) from chatbot_usage where created_at >= date_trunc('day', now()) group by 1;

-- Cola humana envejecida
select id, business_id, handoff_requested_at from conversations
where status = 'pending_human' and handoff_requested_at < now() - interval '15 minutes';

-- Fallos de envío del bot (24 h)
select count(*) from conversation_messages where status = 'failed' and created_at > now() - interval '1 day';
```

### 23.6 Reversión

| Nivel | Acción | Tiempo | Pérdida de datos |
| --- | --- | --- | --- |
| 1 | `update chatbot_settings set enabled=false` (un negocio) | Inmediato | Ninguna |
| 2 | `CHATBOT_ENABLED=false` en Vercel + redeploy | Minutos | Ninguna |
| 3 | Revertir el commit del router (vuelve `handleCustomerReply` directo) | Minutos | Ninguna |
| 4 | Migraciones `down` | Minutos | Datos del chatbot (exportar antes) |

### 23.7 Runbook (contenido mínimo de `docs/chatbot/RUNBOOK.md`, T-14.2)

Activar/desactivar; rotar `GEMINI_API_KEY`/`VOYAGE_API_KEY`/`CHATBOT_PROMPT_CANARY`; reprocesar todas las fuentes de un negocio; cambiar de modelo; subir tope de gasto; liberar conversaciones de un operador ausente; borrar datos de un contacto; restaurar respaldo.

---

## 24. Estimación de costos

### 24.1 Precios unitarios usados

> **Revisión 2026-11-19:** la demo usa Gemini en capa gratuita y Voyage `voyage-4-lite` (costo cero dentro de sus cupos; los límites vigentes se verifican en cada consola). Las tablas de Claude de abajo son la referencia de costo si se pasa a un modelo de pago. El costo en USD que muestra el panel es una **estimación a precio de lista**, no lo que se factura.

| Concepto | Precio | Fuente / estado |
| --- | --- | --- |
| `claude-opus-5-5` | USD 4 entrada / 20 salida por millón de tokens; lectura de caché 0,20 | Referencia oficial de Anthropic (2026-11-03) |
| `claude-sonnet-5-5` | USD 2 / 10; lectura de caché 0,10 | idem |
| `claude-haiku-5-5` | USD 0,10 / 0,50 (prompts ≤ 100 k tokens) | idem |
| Embeddings Voyage `voyage-4-lite` | 200 M de tokens gratis por cuenta (según su página de precios) | **[PENDIENTE]** verificar |
| WhatsApp: respuestas libres dentro de la ventana de atención (servicio) | Sin cargo según el modelo de precios por mensaje de Meta | **[PENDIENTE]** verificar tarifa y país de facturación |
| WhatsApp: plantilla de reapertura (utility) fuera de ventana | Cargo por mensaje según país | **[PENDIENTE]** |
| Supabase | Free (500 MB BD, 1 GB Storage, pausa por inactividad) / Pro ~USD 25/mes | **[PENDIENTE]** verificar plan y precio vigente |
| Vercel | Hobby (uso no comercial) / Pro ~USD 20/usuario/mes | **[PENDIENTE]** (D-09) |
| Upstash QStash | Free con cupo diario de mensajes; pago por uso por encima | **[PENDIENTE]** |

### 24.2 Consumo por respuesta de IA (supuestos)

- Entrada: sistema ~2 000 tokens + contexto ~2 500 + historial ~1 000 + pregunta ~100 = **~5 600 tokens** (sin caché, caso conservador: con tráfico bajo la caché de 5 min rara vez acierta y el prefijo puede ser menor que el mínimo cacheable).
- Salida: respuesta ~150 + JSON ~80 + razonamiento interno en esfuerzo `low` ~200 = **~430 tokens** facturados como salida.
- Embedding de la consulta: ~100 tokens (despreciable).

| Modelo | Entrada | Salida | **Total por respuesta** |
| --- | --- | --- | --- |
| `claude-opus-5-5` | 5 600 × 4/1M = 0,0224 | 430 × 20/1M = 0,0086 | **≈ USD 0,031** (≈ 0,024 con caché del sistema) |
| `claude-sonnet-5-5` | 0,0112 | 0,0043 | **≈ USD 0,016** |
| `claude-haiku-5-5` | 0,00056 | 0,000215 | **≈ USD 0,0008** |

Conversación típica: 4 respuestas de IA (los saludos/agradecimientos no usan IA) + 0,3 resúmenes (solo derivadas).

### 24.3 Escenarios mensuales

| Escenario | Negocios | Conversaciones/mes | Respuestas IA/mes | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| --- | --- | --- | --- | --- | --- | --- |
| Bajo | 1 | 300 | 1 200 | ~USD 37 | ~USD 19 | ~USD 1 |
| Medio | 10 | 3 000 | 12 000 | ~USD 370 | ~USD 190 | ~USD 10 |
| Alto | 100 | 50 000 | 200 000 | ~USD 6 200 | ~USD 3 200 | ~USD 160 |

Otros costos por escenario (estimación):

| Concepto | Bajo | Medio | Alto |
| --- | --- | --- | --- |
| Ingesta de conocimiento (embeddings; 50/500/5 000 documentos de ~10 k tokens) | < USD 0,01 | ~USD 0,10 | ~USD 1 |
| Almacenamiento vectorial (~6 KB por fragmento con índices) | ~5 MB | ~50 MB | ~500 MB → requiere Supabase Pro |
| Mensajes de QStash (1 por entrante + mantenimiento 4 320/mes) | ~6 k | ~25 k | ~260 k → plan pago |
| Supabase | Free | Pro | Pro + cómputo mayor |
| Vercel | Hobby* | Pro | Pro |
| WhatsApp (respuestas de servicio) | 0 | 0 | 0 [PENDIENTE] |

\* Si el uso es comercial, Pro (D-09).

### 24.4 Costo de las pruebas de IA

Una corrida completa de `eval:chatbot` (~120 casos) con Opus 5.5 ≈ USD 4; con Haiku 5.5 ≈ USD 0,10. Presupuestar ~10 corridas durante el desarrollo.

### 24.5 Factores que incrementan el costo

1. Modelo elegido (factor ~40× entre Opus 5.5 y Haiku 5.5).
2. Tamaño del contexto recuperado (fragmentos largos o demasiados).
3. Historial largo sin resumen.
4. Abuso (bots, spam) sin rate limit.
5. Esfuerzo `medium/high` (más razonamiento facturado como salida).
6. Reintentos por errores o JSON inválido.
7. Reprocesar documentos grandes con frecuencia.
8. Mensajes de plantilla fuera de ventana (WhatsApp).

### 24.6 Mecanismos de control

- Tope mensual por negocio y tope diario global (07 §19.10), con banner al 80 % y modo solo derivación al 100 %.
- Respuestas sin IA para saludos, agradecimientos y contenido no textual.
- Agrupación de ráfagas (1 llamada por ráfaga).
- Límite de fragmentos/tokens de contexto y de historial; resumen en conversaciones largas.
- Caché del prompt del sistema (prefijo estable byte a byte).
- `max_tokens` acotado (1 024) y `max_answer_chars`.
- Límite de gasto en la consola de cada proveedor (barrera externa).
- Checksum para no re-embeber documentos sin cambios.
- Selección de modelo por negocio y reporte de costo por respuesta en el panel.

---

## 25. Riesgos

| ID | Riesgo | Prob. | Impacto | Mitigación | Responsable |
| --- | --- | --- | --- | --- | --- |
| RK-01 | Regresión en respuestas a recordatorios por el router | Media | **Alto** | Suite R-* previa (T-01.3), router con caída a legacy ante error, lanzamiento oscuro, interruptores | Dev |
| RK-02 | El bot cancela/confirma turnos por frases ambiguas | Media | Alto | Parser estricto con chatbot activo (D-06), IA sin herramientas de turnos | Dev + responsable |
| RK-03 | Alucinaciones comerciales | Media | Alto | Guardas de §14.5, umbrales, evaluación AI-*, revisión de preguntas sin respuesta | Dev |
| RK-04 | Costos de IA mayores a lo previsto | Media | Medio | Topes, modelo por negocio, monitoreo diario | Responsable |
| RK-05 | Fuga de datos entre negocios | Baja | **Alto** | Filtro obligatorio por `business_id`, S-*, RLS de respaldo | Dev |
| RK-06 | Cupo de QStash agotado (también afectaría recordatorios) | Media | **Alto** | Medir consumo; plan pago antes de escenario medio; alerta | Responsable |
| RK-07 | Límite de duración de funciones en Vercel en jobs de ingesta | Media | Medio | Procesamiento por tandas con auto re-encolado; `maxDuration` | Dev |
| RK-08 | Cambios en la Cloud API / códigos de error de Meta | Baja | Medio | Versión fija `v26.0`; pruebas W-*; revisar changelog de Meta | Dev |
| RK-09 | Migración a Supabase Auth bloquea el acceso al panel | Media | Medio | Login legacy en paralelo (D-02), pruebas R-15 | Dev |
| RK-10 | Operadores no responden (cola envejecida) | Media | Medio | Avisos fuera de horario, banner a admins, métricas | Responsable |
| RK-11 | Extracción de PDF/DOCX falla en el runtime serverless | Media | Medio | Prueba de humo en Preview (T-05.3); alternativa: solo TXT/FAQ en MVP | Dev |
| RK-12 | Inyección de prompt exitosa | Baja | Medio | Capas de §19.8; sin herramientas con efectos | Dev |
| RK-13 | Datos personales en proveedores de IA | Media | Medio | Minimización, política de privacidad, términos del proveedor (sin entrenamiento) | Responsable |
| RK-14 | Plan gratuito de Supabase pausa el proyecto por inactividad | Baja | Alto | Pro en producción | Responsable |
| RK-15 | Una sola persona desarrolla y opera (bus factor) | Alta | Medio | Runbook, documentación, pruebas automatizadas | Responsable |

---

## 27. Checklist de puesta en producción

### Antes del despliegue
- [ ] Decisiones D-01…D-12 cerradas y registradas.
- [ ] CI verde en `main`; R-* 20/20; S-* 100 %; W-* 100 %; H-* 100 %.
- [ ] `eval:chatbot` cumple umbrales AI-* con el modelo elegido; reporte archivado.
- [ ] Revisión de seguridad (T-12.5) sin hallazgos altos.
- [ ] Respaldo de producción hecho y verificado (restaurable).
- [ ] Migraciones 0005–0011 probadas `up → down → up` en dev.
- [ ] Variables de entorno cargadas en Vercel Production (sin valores en el repo).
- [ ] Límites de gasto configurados en consolas de Google (Gemini) y Voyage.
- [ ] Supabase Auth: registro deshabilitado, URLs de redirección de producción, plantillas de email en español.
- [ ] Bucket `knowledge` privado.
- [ ] Planes de Vercel, Supabase y QStash adecuados al escenario.
- [ ] `/privacidad` actualizada (IA, proveedores, retención).

### Despliegue
- [ ] Migraciones aplicadas; conteos de tablas existentes idénticos.
- [ ] `businesses.wa_phone_number_id` configurado.
- [ ] Deploy con `CHATBOT_ENABLED=false`; prueba de humo R-01/R-06/R-13/R-15.
- [ ] 48 h de lanzamiento oscuro sin incidentes.
- [ ] Schedule de QStash `conversations-maintenance` creado.
- [ ] Owner y operadores invitados y con acceso.
- [ ] Base de conocimiento del piloto cargada (≥ 20 FAQ) y probada en la zona de pruebas.
- [ ] Horarios humanos y mensajes revisados por el negocio.

### Activación
- [ ] Piloto activado; W-01…W-15 manuales en producción con teléfonos del equipo.
- [ ] Monitoreo diario (§23.5) durante la primera semana.
- [ ] Umbrales §23.4 cumplidos.
- [ ] README, `.env.example` y RUNBOOK actualizados.
- [ ] Revisión post-lanzamiento agendada (T-14.3).
