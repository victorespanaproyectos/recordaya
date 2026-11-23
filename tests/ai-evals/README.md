# Evaluación de la IA

Set dorado (T-02.2) y ejecutor (T-07.7). **No corre en CI ni con `npm test`**: usa proveedores reales y gasta su cupo.

## Qué hay
- `fixtures/barberia.json` — negocio de ejemplo: 20 FAQ y 3 textos. `barberia-conflicto.json` (AI-04) y `barberia-envenenada.json` (AI-08) la extienden.
- `cases.json` — 170 casos en 11 grupos (AI-01 … AI-11, ver `docs/chatbot/09-plan-de-pruebas.md`). Cada caso trae `expected` verificable automáticamente (`score.ts`).
- AI-12 (tope de gasto) lo cubre `tests/chatbot/job.test.ts`; AI-13 (tono) necesita revisión humana de las 20 respuestas que el reporte incluye.

## Cómo correrlo
Necesita `.env.test` (base de pruebas, nunca producción) y en `.env.local`: `GEMINI_API_KEY`, `VOYAGE_API_KEY`, `CHATBOT_ALLOWED_MODELS` y `CHATBOT_DEFAULT_MODEL`.

```bash
npm run eval:chatbot
```

Variables opcionales: `EVAL_ONLY=AI-01,AI-07` (grupos), `EVAL_LIMIT=5` (casos por grupo), `EVAL_DELAY_MS=5000` (pausa entre casos; sube el valor si el proveedor limita las peticiones por minuto), `EVAL_INGEST_DELAY_MS`.
`EVAL_PROVIDER=fake` usa proveedores falsos solo para probar el ejecutor (los resultados no valen).

El ejecutor crea negocios de prueba, los borra al terminar y escribe el reporte en `reports/`. Falla (código ≠ 0) si algún grupo queda por debajo de su umbral.
