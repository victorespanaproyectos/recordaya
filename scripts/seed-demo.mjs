/**
 * Carga 20 turnos de demostración (con mensajes, estados y respuestas) para que el panel
 * muestre la app en uso. NO envía WhatsApp: inserta directo en la base con números ficticios.
 *
 * Uso:
 *   node --env-file=.env.local scripts/seed-demo.mjs --yes
 *   node --env-file=.env.local scripts/seed-demo.mjs --reset --backup <carpeta> --yes
 *
 *   --reset   borra TODOS los turnos, clientes, mensajes, respuestas y webhooks (conserva negocios)
 *   --backup  antes de borrar, guarda un JSON con todo lo que se va a eliminar
 *   --yes     confirmación explícita (sin esto no hace nada)
 *
 * Los recordatorios futuros quedan "queued" con schedule_id = "demo-seed": se ven como programados
 * en el panel, pero el job de dispatch los ignora (nunca se envían).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL_BASE || !KEY) {
  console.error("Faltan SUPABASE_URL / SUPABASE_SECRET_KEY (usa node --env-file=...)");
  process.exit(1);
}
if (!flag("yes")) {
  console.error(`Destino: ${URL_BASE}\nAgrega --yes para confirmar.`);
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function api(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const insert = (table, rows, prefer = "return=representation") =>
  api(table, { method: "POST", headers: { Prefer: prefer }, body: JSON.stringify(rows) });

// ── Negocio ─────────────────────────────────────────────────
const businesses = await api("businesses?select=id,name,timezone,address&order=created_at");
const business = businesses[0];
if (!business) throw new Error("No hay negocios: crea uno primero.");
console.log(`Base: ${URL_BASE}\nNegocio: ${business.name}`);

// ── Respaldo + limpieza ─────────────────────────────────────
const TABLES = ["webhook_events", "inbound_messages", "messages", "appointments", "customers"];
if (flag("reset")) {
  const backupDir = option("backup");
  if (backupDir) {
    const dump = {};
    for (const t of TABLES) dump[t] = await api(`${t}?select=*`);
    mkdirSync(backupDir, { recursive: true });
    const file = join(backupDir, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(dump, null, 2));
    console.log(`Respaldo: ${file} (${TABLES.map((t) => `${t}=${dump[t].length}`).join(", ")})`);
  }
  for (const t of TABLES) {
    const filter = t === "webhook_events" ? "id=gte.0" : "id=not.is.null";
    await api(`${t}?${filter}`, { method: "DELETE" });
  }
  console.log("Limpieza: OK (negocios conservados)");
}

// ── Datos de demo ───────────────────────────────────────────
let seed = 20261115;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const wamid = () => `wamid.DEMO.${Math.floor(rand() * 1e12).toString(36)}${Math.floor(rand() * 1e12).toString(36)}`;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = business.timezone || "America/Montevideo";

/** Instante para "día relativo a hoy" + hora local del negocio (Uruguay: UTC-3 todo el año). */
function at(dayOffset, hh, mm = 0) {
  const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
  const [y, m, d] = todayLocal.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + dayOffset, hh + 3, mm));
}
const fecha = (d) =>
  new Intl.DateTimeFormat("es-UY", { weekday: "long", day: "numeric", month: "long", timeZone: TZ }).format(d).replace(",", "");
const hora = (d) =>
  new Intl.DateTimeFormat("es-UY", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ }).format(d);

const CUSTOMERS = [
  ["Lucía Fernández", "59891000101"], ["Martín Rodríguez", "59891000102"], ["Valentina Gómez", "59891000103"],
  ["Joaquín Pereira", "59891000104"], ["Camila Silva", "59891000105"], ["Santiago Núñez", "59891000106"],
  ["Florencia Díaz", "59891000107"], ["Matías Suárez", "59891000108"], ["Sofía Martínez", "59891000109"],
  ["Nicolás Castro", "59891000110"], ["Agustina Romero", "59891000111"], ["Facundo Acosta", "59891000112"],
  ["Micaela Sosa", "59891000113"], ["Bruno Álvarez", "59891000114"],
];

/**
 * Guion de los 20 turnos: [cliente, día relativo, hora, servicio, escenario].
 * Escenarios: completed · no_show · cancel_client · cancel_business · confirmed · scheduled · rescheduled · failed
 */
const PLAN = [
  // Pasados
  [0, -12, 10, "Corte de pelo", "completed"],
  [1, -11, 16, "Corte + barba", "completed"],
  [2, -9, 11, "Coloración", "completed"],
  [3, -8, 18, "Barba", "no_show"],
  [4, -6, 15, "Corte de pelo", "cancel_client"],
  [5, -5, 12, "Afeitado clásico", "completed"],
  [6, -3, 17, "Corte + barba", "completed"],
  [7, -2, 10, "Corte de pelo", "cancel_business"],
  [0, -1, 11, "Barba", "completed"],
  [8, -1, 19, "Corte de pelo", "no_show"],
  // Hoy
  [9, 0, 10, "Corte de pelo", "completed"],
  [10, 0, 15, "Coloración", "completed"],
  // Próximos
  [11, 1, 10, "Corte + barba", "confirmed"],
  [1, 1, 12, "Corte de pelo", "confirmed"],
  [12, 1, 16, "Coloración", "rescheduled"],
  [13, 1, 18, "Barba", "scheduled"],
  [2, 2, 11, "Corte de pelo", "confirmed"],
  [6, 1, 19, "Afeitado clásico", "failed"],
  [4, 3, 15, "Corte de pelo", "scheduled"],
  [5, 5, 10, "Corte + barba", "scheduled"],
];

const customerRows = await insert(
  "customers?on_conflict=business_id,phone",
  CUSTOMERS.map(([name, phone]) => ({ business_id: business.id, name, phone })),
  "return=representation,resolution=merge-duplicates",
);
const customerByPhone = Object.fromEntries(customerRows.map((c) => [c.phone, c]));

const now = Date.now();
const FINAL = { completed: "completed", no_show: "no_show", cancel_client: "cancelled", cancel_business: "cancelled" };
const STATUS = {
  ...FINAL,
  confirmed: "confirmed",
  scheduled: "scheduled",
  rescheduled: "rescheduled",
  failed: "scheduled",
};

let created = 0;
for (const [ci, day, hh, service, scenario] of PLAN) {
  const [name, phone] = CUSTOMERS[ci];
  const customer = customerByPhone[phone];
  const first = name.split(" ")[0];
  const start = at(day, hh, pick([0, 0, 30]));
  const bookedAt = new Date(Math.min(start.getTime() - (2 + Math.floor(rand() * 5)) * DAY, now - 3 * HOUR) - Math.floor(rand() * 6) * HOUR);

  const [appt] = await insert("appointments", [
    {
      business_id: business.id,
      customer_id: customer.id,
      starts_at: start.toISOString(),
      service,
      status: STATUS[scenario],
      created_at: bookedAt.toISOString(),
      notes: scenario === "completed" && rand() < 0.3 ? "Cliente habitual, prefiere máquina 2 a los costados." : null,
    },
  ]);

  const messages = [];
  const replies = [];
  const vars = { nombre: name, negocio: business.name, fecha: fecha(start), hora: hora(start) };

  /** Mensaje enviado con estado read/delivered según cuánto tiempo pasó. */
  const sent = (kind, template, variables, sentAt, opts = {}) => {
    const t = sentAt.getTime();
    const readLater = t + (2 + Math.floor(rand() * 90)) * MIN;
    const status = opts.status ?? (readLater < now && rand() < 0.85 ? "read" : "delivered");
    messages.push({
      business_id: business.id,
      appointment_id: appt.id,
      to_phone: phone,
      kind,
      template_name: template,
      variables,
      wa_message_id: status === "failed" ? null : wamid(),
      status,
      scheduled_for: kind.startsWith("reminder") ? sentAt.toISOString() : null,
      sent_at: status === "failed" ? null : sentAt.toISOString(),
      delivered_at: status === "failed" ? null : new Date(t + 4000).toISOString(),
      read_at: status === "read" ? new Date(readLater).toISOString() : null,
      failed_at: status === "failed" ? sentAt.toISOString() : null,
      error: opts.error ?? null,
      created_at: sentAt.toISOString(),
    });
    return new Date(status === "read" ? readLater : t + 4000);
  };
  const queued = (kind, sendAt) =>
    messages.push({
      business_id: business.id,
      appointment_id: appt.id,
      to_phone: phone,
      kind,
      template_name: "event_details_reminder_2",
      variables: {},
      status: "queued",
      scheduled_for: sendAt.toISOString(),
      schedule_id: "demo-seed",
      created_at: bookedAt.toISOString(),
    });
  const reply = (body, intent, receivedAt) =>
    replies.push({
      wa_message_id: wamid(),
      from_phone: phone,
      type: "text",
      body,
      intent,
      appointment_id: appt.id,
      reply_to_wa_message_id: null,
      payload: { demo: true },
      received_at: receivedAt.toISOString(),
    });
  const textReply = (body, at) =>
    sent("reply", "text", { body }, at, { status: at.getTime() + 10 * MIN < now ? "read" : "delivered" });

  // 1) Confirmación al reservar
  sent("confirmation", "appointment_confirmation_1", { ...vars, servicio: service }, new Date(bookedAt.getTime() + 20_000));

  // 2) Recordatorios 24 h y 2 h
  const r24 = new Date(start.getTime() - DAY);
  const r2 = new Date(start.getTime() - 2 * HOUR);
  const remindersStop = scenario.startsWith("cancel") ? "cancel" : null;
  let confirmedAt = null;

  if (r24 > bookedAt) {
    if (r24.getTime() < now && !(scenario === "cancel_business" && day >= -2)) {
      const seen = sent("reminder_24h", "event_details_reminder_2", vars, r24,
        scenario === "failed" ? { status: "failed", error: { message: "(#131026) Message undeliverable", code: 131026 } } : {});
      const answerAt = new Date(seen.getTime() + (1 + Math.floor(rand() * 40)) * MIN);
      if (["completed", "confirmed"].includes(scenario) && answerAt.getTime() < now) {
        reply(pick(["1", "1", "Sí, confirmo", "1 👍", "Confirmo"]), "confirm", answerAt);
        textReply(`¡Gracias, ${first}! Tu turno del ${vars.fecha} a las ${vars.hora} en ${business.name} quedó confirmado. ✅`, new Date(answerAt.getTime() + 3000));
        confirmedAt = answerAt;
      } else if (scenario === "cancel_client") {
        reply(pick(["2", "No voy a poder, cancelo", "2, disculpen"]), "cancel", answerAt);
        sent("cancellation", "appointment_cancellation_1", vars, new Date(answerAt.getTime() + 3000));
      } else if (scenario === "rescheduled") {
        reply("¿Puede ser un poco más tarde ese día?", "unknown", answerAt);
        textReply(`Hola ${first}, tienes un turno el ${vars.fecha} a las ${vars.hora} en ${business.name}.\nResponde *1* para confirmar o *2* para cancelar.`, new Date(answerAt.getTime() + 3000));
      }
    } else if (r24.getTime() >= now && !remindersStop) {
      queued("reminder_24h", r24);
    }
  }

  if (scenario === "cancel_business") {
    sent("cancellation", "appointment_cancellation_1", vars, new Date(start.getTime() - 30 * HOUR));
  }

  if (r2.getTime() < now && !remindersStop && scenario !== "failed") {
    const template = confirmedAt ? "event_details_reminder_1" : "event_details_reminder_2";
    const r2vars = confirmedAt
      ? { servicio: service, negocio: business.name, fecha: vars.fecha, hora: vars.hora, direccion: business.address ?? business.name }
      : vars;
    sent("reminder_2h", template, r2vars, r2);
  } else if (r2.getTime() >= now && !remindersStop) {
    queued("reminder_2h", r2);
  }

  // Uno por uno: PostgREST exige las mismas columnas en todas las filas de un insert múltiple.
  for (const m of messages) await insert("messages", [m], "return=minimal");
  for (const r of replies) await insert("inbound_messages", [r], "return=minimal");
  created++;
}

console.log(`Demo: ${created} turnos, ${CUSTOMERS.length} clientes.`);
