"use client";

import {
  CalendarClock,
  CircleCheck,
  CircleX,
  EllipsisVertical,
  LoaderCircle,
  UserCheck,
  UserX,
} from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import { dayKey } from "@/lib/dates";
import type { StatusUpdate } from "@/lib/appointments/service";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { rescheduleAction, setStatusAction, type ActionResult } from "./actions";

interface Props {
  id: string;
  status: string;
  startsAt: string;
  timeZone: string;
  customerName: string;
  /** "menu" = botón ⋮ compacto (lista) · "bar" = botones visibles (detalle). */
  layout?: "menu" | "bar";
}

const ACTIVE = ["scheduled", "confirmed", "rescheduled"];

export function AppointmentActions({ id, status, startsAt, timeZone, customerName, layout = "menu" }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "cancel" | "reschedule">(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [now] = useState(() => Date.now());

  // Cerrar el menú al hacer clic afuera o con Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const isActive = ACTIVE.includes(status);
  const isPast = new Date(startsAt).getTime() < now;
  if (!isActive) return null;

  const run = (next: StatusUpdate, notify = true) => {
    setMenuOpen(false);
    startTransition(async () => {
      const result = await setStatusAction(id, next, notify);
      report(result);
      if (result.ok) setDialog(null);
    });
  };

  const report = (result: ActionResult) => {
    if (result.ok) {
      toast({ kind: "success", title: result.message ?? "Listo" });
      if (result.warning) toast({ kind: "warning", title: "Aviso", description: result.warning });
    } else {
      toast({ kind: "error", title: "No se pudo completar", description: result.error });
    }
  };

  const items = [
    status !== "confirmed" && !isPast && {
      key: "confirm",
      label: "Confirmar",
      icon: <CircleCheck className="size-4 text-emerald-600" />,
      onSelect: () => run("confirmed"),
    },
    !isPast && {
      key: "reschedule",
      label: "Reprogramar",
      icon: <CalendarClock className="size-4 text-amber-600" />,
      onSelect: () => {
        setMenuOpen(false);
        setDialog("reschedule");
      },
    },
    {
      key: "completed",
      label: "Marcar atendido",
      icon: <UserCheck className="size-4 text-slate-500" />,
      onSelect: () => run("completed"),
    },
    {
      key: "no_show",
      label: "Marcar ausente",
      icon: <UserX className="size-4 text-orange-600" />,
      onSelect: () => run("no_show"),
    },
    !isPast && {
      key: "cancel",
      label: "Cancelar turno",
      danger: true,
      icon: <CircleX className="size-4" />,
      onSelect: () => {
        setMenuOpen(false);
        setDialog("cancel");
      },
    },
  ].filter(Boolean) as { key: string; label: string; icon: React.ReactNode; danger?: boolean; onSelect: () => void }[];

  return (
    <>
      {layout === "bar" ? (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              disabled={pending}
              onClick={item.onSelect}
              className={cn(item.danger ? buttonStyles.secondary + " text-rose-600" : buttonStyles.secondary)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
          {pending && <LoaderCircle className="size-5 animate-spin self-center text-muted" />}
        </div>
      ) : (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Acciones del turno de ${customerName}`}
            disabled={pending}
            className="rounded-xl p-2 text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            {pending ? <LoaderCircle className="size-5 animate-spin" /> : <EllipsisVertical className="size-5" />}
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="animate-fade-in absolute top-full right-0 z-30 mt-1 w-52 overflow-hidden rounded-2xl border border-border bg-surface p-1.5 shadow-card"
            >
              {items.map((item) => (
                <button
                  key={item.key}
                  role="menuitem"
                  type="button"
                  onClick={item.onSelect}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium transition hover:bg-surface-2",
                    item.danger && "text-rose-600 hover:bg-rose-500/10",
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <CancelDialog
        open={dialog === "cancel"}
        customerName={customerName}
        pending={pending}
        onClose={() => setDialog(null)}
        onConfirm={(notify) => run("cancelled", notify)}
      />
      {dialog === "reschedule" && (
        <RescheduleDialog
          id={id}
          startsAt={startsAt}
          timeZone={timeZone}
          customerName={customerName}
          onClose={() => setDialog(null)}
          onResult={(r) => {
            report(r);
            if (r.ok) setDialog(null);
          }}
        />
      )}
    </>
  );
}

function CancelDialog({
  open,
  customerName,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  customerName: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (notify: boolean) => void;
}) {
  const [notify, setNotify] = useState(true);
  return (
    <Modal open={open} onClose={onClose} title="¿Cancelar este turno?" description={`Turno de ${customerName}`}>
      <p className="text-sm text-muted">
        Se cancelan los recordatorios pendientes. Esta acción no se puede deshacer.
      </p>
      <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 text-sm font-medium">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          className="size-4 accent-[var(--brand)]"
        />
        Avisar al cliente por WhatsApp
      </label>
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={buttonStyles.secondary}>
          Volver
        </button>
        <button type="button" disabled={pending} onClick={() => onConfirm(notify)} className={buttonStyles.danger}>
          {pending && <LoaderCircle className="size-4 animate-spin" />}
          Cancelar turno
        </button>
      </div>
    </Modal>
  );
}

function RescheduleDialog({
  id,
  startsAt,
  timeZone,
  customerName,
  onClose,
  onResult,
}: {
  id: string;
  startsAt: string;
  timeZone: string;
  customerName: string;
  onClose: () => void;
  onResult: (r: ActionResult) => void;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(rescheduleAction, null);
  const current = new Date(startsAt);
  const currentTime = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(current);

  const handled = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (!state || handled.current === state) return;
    handled.current = state;
    onResult(state);
  }, [state, onResult]);

  return (
    <Modal open onClose={onClose} title="Reprogramar turno" description={`Turno de ${customerName}`}>
      <form action={action} className="space-y-4">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="timeZone" value={timeZone} />
        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          <label className="space-y-1.5 text-sm font-medium">
            Nueva fecha
            <input
              type="date"
              name="date"
              required
              min={dayKey(new Date(), timeZone)}
              defaultValue={dayKey(current, timeZone)}
              className={inputStyles}
            />
          </label>
          <label className="space-y-1.5 text-sm font-medium">
            Hora
            <input type="time" name="time" required step={300} defaultValue={currentTime} className={inputStyles} />
          </label>
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-border p-3 text-sm font-medium">
          <input type="checkbox" name="notify" defaultChecked className="size-4 accent-[var(--brand)]" />
          Enviar la nueva fecha por WhatsApp
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className={buttonStyles.secondary}>
            Volver
          </button>
          <button type="submit" disabled={pending} className={buttonStyles.primary}>
            {pending && <LoaderCircle className="size-4 animate-spin" />}
            Reprogramar
          </button>
        </div>
      </form>
    </Modal>
  );
}
