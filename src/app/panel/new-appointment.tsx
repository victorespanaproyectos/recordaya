"use client";

import { Check, CheckCheck, LoaderCircle, Plus, Sparkles, Zap } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import { dayKey, formatFecha, zonedToUtc } from "@/lib/dates";
import type { Business } from "@/lib/panel/data";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { createAppointmentAction, type ActionResult } from "./actions";

const COUNTRIES = [
  { code: "598", label: "🇺🇾 +598" },
  { code: "54", label: "🇦🇷 +54" },
  { code: "56", label: "🇨🇱 +56" },
  { code: "57", label: "🇨🇴 +57" },
  { code: "52", label: "🇲🇽 +52" },
  { code: "34", label: "🇪🇸 +34" },
  { code: "1", label: "🇺🇸 +1" },
];

const SERVICES = ["Corte de pelo", "Barba", "Corte + barba", "Coloración", "Consulta"];

/** Fecha y hora "HH:MM" en la zona del negocio, redondeada a 5 min hacia arriba. */
function zonedNow(timeZone: string, addMinutes = 0) {
  const d = new Date(Date.now() + addMinutes * 60_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return { date: dayKey(d, timeZone), time };
}

export function NewAppointmentButton({ businesses }: { businesses: Business[] }) {
  const [open, setOpen] = useState(false);
  // Cambiar la key reinicia el formulario cada vez que se abre.
  const [formKey, setFormKey] = useState(0);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFormKey((k) => k + 1);
          setOpen(true);
        }}
        className={buttonStyles.primary}
      >
        <Plus className="size-4" />
        Nuevo turno
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        variant="sheet"
        title="Nuevo turno"
        description="Se envía la confirmación y se programan los recordatorios automáticamente."
      >
        <NewAppointmentForm key={formKey} businesses={businesses} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function NewAppointmentForm({ businesses, onDone }: { businesses: Business[]; onDone: () => void }) {
  const toast = useToast();
  const ids = useId();
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createAppointmentAction, null);

  const [businessId, setBusinessId] = useState(businesses[0]?.id ?? "");
  const business = businesses.find((b) => b.id === businessId) ?? businesses[0];
  const tz = business?.timezone ?? "America/Montevideo";

  const initial = useMemo(() => zonedNow(tz, 24 * 60), [tz]);
  const [name, setName] = useState("");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState("10:00");
  // Por defecto: mañana 10:00, así que ese atajo arranca marcado.
  const [picked, setPicked] = useState<{ label: string; date: string; time: string } | null>({
    label: "Mañana 10:00",
    date: initial.date,
    time: "10:00",
  });
  const [service, setService] = useState("");
  const [notify, setNotify] = useState(true);
  // "Ahora" fijo durante la vida del formulario (el render debe ser puro).
  const [now] = useState(() => Date.now());

  const handled = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (!state || handled.current === state) return;
    handled.current = state;
    if (state.ok) {
      toast({ kind: "success", title: state.message ?? "Turno creado" });
      if (state.warning) toast({ kind: "warning", title: "Aviso", description: state.warning });
      onDone();
    }
  }, [state, toast, onDone]);

  const startsAt = zonedToUtc(date, time, tz);
  const isPast = startsAt ? startsAt.getTime() <= now : false;
  const preview = startsAt ? { fecha: formatFecha(startsAt, tz), hora: time } : null;
  const minDate = zonedNow(tz).date;

  const quick: { label: string; hint?: string; icon?: React.ReactNode; target: () => { date: string; time: string } }[] = [
    {
      label: "En 2 h 5 min",
      hint: "Ideal para la demo: el recordatorio de 2 h llega en ~5 minutos",
      icon: <Zap className="size-3.5" />,
      target: () => zonedNow(tz, 125),
    },
    { label: "Mañana 10:00", target: () => ({ date: zonedNow(tz, 24 * 60).date, time: "10:00" }) },
    { label: "En 3 días", target: () => ({ date: zonedNow(tz, 3 * 24 * 60).date, time: "16:00" }) },
  ];

  const applyQuick = (q: (typeof quick)[number]) => {
    const t = q.target();
    setDate(t.date);
    setTime(t.time);
    setPicked({ label: q.label, ...t });
  };
  // Un atajo está activo mientras la fecha y hora sigan siendo las que puso (editar a mano lo desmarca).
  const isPicked = (label: string) => picked?.label === label && picked.date === date && picked.time === time;

  if (!business) {
    return (
      <p className="text-sm text-muted">
        Todavía no hay negocios. Crea uno en Supabase (ver README) para empezar a cargar turnos.
      </p>
    );
  }

  return (
    <form action={action} className="space-y-6">
      {/* Negocio */}
      {businesses.length > 1 ? (
        <Field label="Negocio" htmlFor={`${ids}-b`}>
          <select
            id={`${ids}-b`}
            name="businessId"
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
            className={inputStyles}
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <input type="hidden" name="businessId" value={business.id} />
      )}

      {/* Cliente */}
      <fieldset className="space-y-4">
        <legend className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">Cliente</legend>
        <Field label="Nombre" htmlFor={`${ids}-n`}>
          <input
            id={`${ids}-n`}
            name="name"
            required
            autoComplete="off"
            placeholder="Ej. Victoria Pérez"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputStyles}
          />
        </Field>
        <Field label="WhatsApp" htmlFor={`${ids}-p`} hint="El número debe tener WhatsApp. Solo dígitos, sin el 0 inicial.">
          <div className="flex gap-2">
            <select name="countryCode" defaultValue="598" aria-label="Código de país" className={cn(inputStyles, "w-auto pr-8")}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              id={`${ids}-p`}
              name="phone"
              required
              inputMode="numeric"
              pattern="[0-9 ]{6,14}"
              placeholder="99 123 456"
              autoComplete="off"
              className={inputStyles}
            />
          </div>
        </Field>
      </fieldset>

      {/* Turno */}
      <fieldset className="space-y-4">
        <legend className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">Turno</legend>
        <div className="flex flex-wrap gap-2">
          {quick.map((q) => {
            const active = isPicked(q.label);
            return (
              <button
                key={q.label}
                type="button"
                title={q.hint}
                aria-pressed={active}
                onClick={() => applyQuick(q)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  active
                    ? "border-brand bg-brand text-brand-fg shadow-sm"
                    : "border-border bg-surface-2 hover:border-brand hover:text-brand",
                )}
              >
                {active ? <Check className="size-3.5" /> : q.icon}
                {q.label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          <Field label="Fecha" htmlFor={`${ids}-d`}>
            <input
              id={`${ids}-d`}
              type="date"
              name="date"
              required
              min={minDate}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputStyles}
            />
          </Field>
          <Field label="Hora" htmlFor={`${ids}-t`}>
            <input
              id={`${ids}-t`}
              type="time"
              name="time"
              required
              step={300}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={inputStyles}
            />
          </Field>
        </div>
        {isPast && <p className="text-sm font-medium text-amber-600 dark:text-amber-400">Esa hora ya pasó: elige una futura.</p>}
        <Field label="Servicio" htmlFor={`${ids}-s`} optional>
          <input
            id={`${ids}-s`}
            name="service"
            list={`${ids}-services`}
            placeholder="Ej. Corte de pelo"
            value={service}
            onChange={(e) => setService(e.target.value)}
            className={inputStyles}
          />
          <datalist id={`${ids}-services`}>
            {SERVICES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Notas internas" htmlFor={`${ids}-x`} optional>
          <textarea id={`${ids}-x`} name="notes" rows={2} placeholder="Solo las ves tú" className={cn(inputStyles, "resize-none")} />
        </Field>
      </fieldset>

      {/* Envío */}
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border p-4 transition has-checked:border-brand has-checked:bg-brand-soft/60">
        <input
          type="checkbox"
          name="notify"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          className="mt-0.5 size-4 accent-[var(--brand)]"
        />
        <span>
          <span className="block text-sm font-semibold">Enviar confirmación por WhatsApp ahora</span>
          <span className="block text-sm text-muted">Los recordatorios de 24 h y 2 h se programan siempre.</span>
        </span>
      </label>

      {notify && preview && (
        <div className="rounded-2xl bg-[#efeae2] p-4 dark:bg-[#0b141a]" aria-label="Vista previa del mensaje">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[#54656f] dark:text-[#8696a0]">
            <Sparkles className="size-3.5" /> Vista previa
          </p>
          <div className="max-w-[92%] rounded-xl rounded-tl-sm bg-white px-3.5 py-2.5 text-sm text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
            Hola <b>{name.trim() || "…"}</b>, Gracias por reservar con <b>{business.name}</b>. Se confirma su cita
            para <b>{service.trim() || "tu turno"}</b> el <b>{preview.fecha}</b> a las <b>{preview.hora}</b>.
            <span className="mt-1 flex items-center justify-end gap-1 text-[11px] text-[#667781]">
              ahora <CheckCheck className="size-3.5 text-sky-500" />
            </span>
          </div>
        </div>
      )}

      {state && !state.ok && (
        <p role="alert" className="animate-fade-in rounded-xl bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-700 dark:text-rose-300">
          {state.error}
        </p>
      )}

      <div className="sticky bottom-0 -mx-6 flex items-center gap-3 border-t border-border bg-surface px-6 py-4">
        <button type="submit" disabled={pending || isPast} className={cn(buttonStyles.primary, "flex-1")}>
          {pending && <LoaderCircle className="size-4 animate-spin" />}
          {pending ? "Creando turno…" : "Crear turno"}
        </button>
        <button type="button" onClick={onDone} className={buttonStyles.secondary}>
          Cancelar
        </button>
      </div>
      {state?.ok && state.id && (
        <Link href={`/panel/turnos/${state.id}`} className="sr-only">
          Ver turno creado
        </Link>
      )}
    </form>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  optional,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="flex items-baseline justify-between text-sm font-medium">
        {label}
        {optional && <span className="text-xs font-normal text-muted">Opcional</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
