"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import type { HumanHours, Weekday } from "@/lib/chatbot/conversations/hours";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";

const DAYS: { id: Weekday; label: string }[] = [
  { id: "mon", label: "Lunes" },
  { id: "tue", label: "Martes" },
  { id: "wed", label: "Miércoles" },
  { id: "thu", label: "Jueves" },
  { id: "fri", label: "Viernes" },
  { id: "sat", label: "Sábado" },
  { id: "sun", label: "Domingo" },
];

/** Grilla semanal de franjas y excepciones por fecha. Envía el resultado como JSON en `human_hours`. */
export function HoursEditor({ initial, timeZone }: { initial: HumanHours; timeZone: string }) {
  const [hours, setHours] = useState<HumanHours>(initial);
  const [newDate, setNewDate] = useState("");

  const setRanges = (day: Weekday, ranges: [string, string][]) => setHours((h) => ({ ...h, [day]: ranges }));
  const exceptions = hours.exceptions ?? [];

  return (
    <div className="space-y-6">
      <input type="hidden" name="human_hours" value={JSON.stringify(hours)} />
      <p className="text-sm text-muted">
        Horas en la zona horaria del negocio: <span className="font-medium text-fg">{timeZone}</span>. Un día sin franjas
        queda cerrado. El fin de cada franja es exclusivo.
      </p>

      <div className="space-y-3">
        {DAYS.map(({ id, label }) => {
          const ranges = hours[id] ?? [];
          return (
            <div key={id} className="flex flex-wrap items-start gap-3 rounded-xl border border-border p-3">
              <div className="w-24 pt-2 text-sm font-medium">{label}</div>
              <div className="flex-1 space-y-2">
                {ranges.length === 0 && <p className="pt-2 text-sm text-muted">Cerrado</p>}
                {ranges.map(([start, end], i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="time"
                      aria-label={`${label}: inicio de la franja ${i + 1}`}
                      value={start}
                      onChange={(e) => setRanges(id, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                      className={cn(inputStyles, "w-32")}
                    />
                    <span className="text-muted">a</span>
                    <input
                      type="time"
                      aria-label={`${label}: fin de la franja ${i + 1}`}
                      value={end}
                      onChange={(e) => setRanges(id, ranges.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                      className={cn(inputStyles, "w-32")}
                    />
                    <button
                      type="button"
                      aria-label={`${label}: quitar la franja ${i + 1}`}
                      onClick={() => setRanges(id, ranges.filter((_, j) => j !== i))}
                      className={buttonStyles.ghost}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setRanges(id, [...ranges, ranges.length === 0 ? ["09:00", "18:00"] : ["15:00", "19:00"]])}
                className={buttonStyles.secondary}
              >
                <Plus className="size-4" />
                Franja
              </button>
            </div>
          );
        })}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Días cerrados (feriados)</h3>
        {exceptions.length === 0 && <p className="text-sm text-muted">Sin excepciones.</p>}
        <ul className="flex flex-wrap gap-2">
          {exceptions.map((e) => (
            <li key={e.date} className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm">
              {e.date}
              <button
                type="button"
                aria-label={`Quitar ${e.date}`}
                onClick={() => setHours((h) => ({ ...h, exceptions: exceptions.filter((x) => x.date !== e.date) }))}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <input
            type="date"
            aria-label="Fecha cerrada"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className={cn(inputStyles, "w-44")}
          />
          <button
            type="button"
            disabled={!newDate || exceptions.some((e) => e.date === newDate)}
            onClick={() => {
              setHours((h) => ({ ...h, exceptions: [...exceptions, { date: newDate, closed: true as const }].sort((a, b) => a.date.localeCompare(b.date)) }));
              setNewDate("");
            }}
            className={buttonStyles.secondary}
          >
            <Plus className="size-4" />
            Agregar día cerrado
          </button>
        </div>
      </div>
    </div>
  );
}
