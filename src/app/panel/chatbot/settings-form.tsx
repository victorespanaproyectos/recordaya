"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState, useEffect, useId, useState, type ReactNode } from "react";
import { useToast } from "@/components/toaster";
import { renderTemplate } from "@/lib/chatbot/template";
import type { ChatbotSettings } from "@/lib/chatbot/settings";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import type { ActionResult } from "../actions";
import { updateChatbotSettingsAction } from "./actions";
import { HoursEditor } from "./hours-editor";

interface Props {
  settings: ChatbotSettings;
  businessName: string;
  timeZone: string;
  isOwner: boolean;
  allowedModels: string[];
}

const TABS = [
  { id: "general", label: "General" },
  { id: "personalidad", label: "Personalidad" },
  { id: "mensajes", label: "Mensajes" },
  { id: "horario", label: "Horario humano" },
  { id: "comportamiento", label: "Comportamiento" },
  { id: "ia", label: "IA y consumo", ownerOnly: true },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TONES = [
  { id: "friendly", label: "Cercano", hint: "Amable y natural" },
  { id: "formal", label: "Formal", hint: "Respetuoso y profesional" },
  { id: "neutral", label: "Neutro", hint: "Directo, sin adornos" },
] as const;

const MESSAGES = [
  { name: "welcome_message", label: "Bienvenida" },
  { name: "handoff_offer_message", label: "Oferta de pasar con una persona" },
  { name: "handoff_confirmed_message", label: "Transferencia confirmada" },
  { name: "out_of_hours_message", label: "Fuera de horario", hint: "Puedes usar {proximo_horario}." },
  { name: "no_info_message", label: "Sin información" },
  { name: "unsupported_content_message", label: "Contenido no soportado (fotos, audios…)" },
  { name: "closing_message", label: "Cierre de la conversación", optional: true },
] as const;

export function SettingsForm({ settings, businessName, timeZone, isOwner, allowedModels }: Props) {
  const toast = useToast();
  const ids = useId();
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(updateChatbotSettingsAction, null);
  const [tab, setTab] = useState<TabId>("general");
  const [assistantName, setAssistantName] = useState(settings.assistant_name);

  useEffect(() => {
    if (!state) return;
    if (state.ok) toast({ kind: "success", title: state.message ?? "Guardado" });
    else toast({ kind: "error", title: "No se pudo guardar", description: state.error });
  }, [state, toast]);

  const tabs = TABS.filter((t) => !("ownerOnly" in t) || isOwner);
  const panel = (id: TabId, children: ReactNode) => (
    <section id={`${ids}-${id}`} role="tabpanel" aria-labelledby={`${ids}-tab-${id}`} hidden={tab !== id} className="space-y-5">
      {children}
    </section>
  );

  return (
    <form action={action} className="space-y-6">
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${ids}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${ids}-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
              tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {panel(
        "general",
        <>
          <Check name="enabled" label="Chatbot activado" hint="Apagado, los mensajes de los clientes se tratan como hasta ahora." defaultChecked={settings.enabled} />
          <Field label="Nombre del asistente" htmlFor={`${ids}-name`}>
            <input id={`${ids}-name`} name="assistant_name" required maxLength={40} value={assistantName} onChange={(e) => setAssistantName(e.target.value)} className={inputStyles} />
          </Field>
          <Field label="Descripción del negocio" htmlFor={`${ids}-desc`} optional hint="Qué hace tu negocio. El asistente la usa como contexto.">
            <textarea id={`${ids}-desc`} name="business_description" rows={4} maxLength={1000} defaultValue={settings.business_description ?? ""} className={inputStyles} />
          </Field>
          <Field label="Idioma" htmlFor={`${ids}-lang`}>
            <input id={`${ids}-lang`} name="language" required defaultValue={settings.language} className={cn(inputStyles, "w-32")} />
          </Field>
          <Check name="auto_language" label="Responder en el idioma del cliente" defaultChecked={settings.auto_language} />
        </>,
      )}

      {panel(
        "personalidad",
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Tono</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {TONES.map((t) => (
                <label key={t.id} className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-3 has-[:checked]:border-brand">
                  <input type="radio" name="tone" value={t.id} defaultChecked={settings.tone === t.id} className="mt-1" />
                  <span>
                    <span className="block text-sm font-medium">{t.label}</span>
                    <span className="block text-xs text-muted">{t.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Personalidad" htmlFor={`${ids}-pers`} optional>
            <textarea id={`${ids}-pers`} name="personality" rows={3} maxLength={500} defaultValue={settings.personality ?? ""} className={inputStyles} />
          </Field>
          <Field label="Instrucciones" htmlFor={`${ids}-inst`} optional hint="Estas instrucciones no pueden contradecir las reglas de seguridad.">
            <Counted id={`${ids}-inst`} name="instructions" rows={8} max={4000} defaultValue={settings.instructions ?? ""} />
          </Field>
        </>,
      )}

      {panel(
        "mensajes",
        <>
          <p className="text-sm text-muted">
            Variables: <code>{"{negocio}"}</code>, <code>{"{asistente}"}</code>, <code>{"{proximo_horario}"}</code>.
          </p>
          {MESSAGES.map((m) => (
            <MessageField
              key={m.name}
              id={`${ids}-${m.name}`}
              name={m.name}
              label={m.label}
              optional={"optional" in m}
              hint={"hint" in m ? m.hint : undefined}
              defaultValue={(settings[m.name] as string | null) ?? ""}
              vars={{ negocio: businessName, asistente: assistantName, proximo_horario: "mañana a las 9:00" }}
            />
          ))}
        </>,
      )}

      {panel("horario", <HoursEditor initial={settings.human_hours} timeZone={timeZone} />)}

      {panel(
        "comportamiento",
        <>
          <NumberField id={`${ids}-len`} name="max_answer_chars" label="Largo máximo de respuesta (caracteres)" min={200} max={1500} defaultValue={settings.max_answer_chars} />
          <NumberField id={`${ids}-fail`} name="offer_human_after_failures" label="Fallos antes de ofrecer una persona" min={1} max={5} defaultValue={settings.offer_human_after_failures} />
          <NumberField id={`${ids}-inact`} name="inactivity_close_hours" label="Horas de inactividad para cerrar" min={1} max={168} defaultValue={settings.inactivity_close_hours} />
          <NumberField id={`${ids}-conf`} name="confidence_threshold" label="Umbral de confianza (avanzado, 0 a 1)" min={0} max={1} step={0.05} defaultValue={settings.confidence_threshold} />
          <Check name="answer_questions_on_reminder_replies" label="Responder preguntas que llegan como respuesta a un recordatorio" defaultChecked={settings.answer_questions_on_reminder_replies} />
        </>,
      )}

      {isOwner &&
        panel(
          "ia",
          <>
            <Field label="Modelo" htmlFor={`${ids}-model`} hint="Los modelos disponibles los define el servidor.">
              <select id={`${ids}-model`} name="llm_model" defaultValue={settings.llm_model} className={inputStyles}>
                {allowedModels.map((m) => (
                  <option key={m} value={m}>
                    {m === "default" ? "Modelo por defecto del servidor" : m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Esfuerzo de razonamiento" htmlFor={`${ids}-effort`}>
              <select id={`${ids}-effort`} name="llm_effort" defaultValue={settings.llm_effort} className={inputStyles}>
                <option value="low">Bajo</option>
                <option value="medium">Medio</option>
                <option value="high">Alto</option>
              </select>
            </Field>
            <NumberField id={`${ids}-budget`} name="monthly_budget_usd" label="Tope mensual (USD)" min={0} step={0.5} defaultValue={settings.monthly_budget_usd} />
          </>,
        )}

      <div className="flex justify-end border-t border-border pt-4">
        <button type="submit" disabled={pending} className={buttonStyles.primary}>
          {pending && <LoaderCircle className="size-4 animate-spin" />}
          Guardar cambios
        </button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, hint, optional, children }: { label: string; htmlFor: string; hint?: string; optional?: boolean; children: ReactNode }) {
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

function Check({ name, label, hint, defaultChecked }: { name: string; label: string; hint?: string; defaultChecked: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-1 size-4" />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

function NumberField({ id, name, label, min, max, step, defaultValue }: { id: string; name: string; label: string; min: number; max?: number; step?: number; defaultValue: number }) {
  return (
    <Field label={label} htmlFor={id}>
      <input id={id} name={name} type="number" inputMode="decimal" required min={min} max={max} step={step ?? 1} defaultValue={defaultValue} className={cn(inputStyles, "w-40")} />
    </Field>
  );
}

function Counted({ id, name, rows, max, defaultValue }: { id: string; name: string; rows: number; max: number; defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <div>
      <textarea id={id} name={name} rows={rows} maxLength={max} value={value} onChange={(e) => setValue(e.target.value)} className={inputStyles} />
      <p className="mt-1 text-right text-xs text-muted">
        {value.length} / {max}
      </p>
    </div>
  );
}

function MessageField({ id, name, label, hint, optional, defaultValue, vars }: { id: string; name: string; label: string; hint?: string; optional?: boolean; defaultValue: string; vars: Parameters<typeof renderTemplate>[1] }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <Field label={label} htmlFor={id} hint={hint} optional={optional}>
      <textarea id={id} name={name} rows={2} maxLength={1000} required={!optional} value={value} onChange={(e) => setValue(e.target.value)} className={inputStyles} />
      {value.trim() && (
        <div className="mt-2 max-w-sm rounded-2xl rounded-tl-sm bg-emerald-500/10 px-3 py-2 text-sm whitespace-pre-wrap" aria-label="Vista previa">
          {renderTemplate(value, vars)}
        </div>
      )}
    </Field>
  );
}
