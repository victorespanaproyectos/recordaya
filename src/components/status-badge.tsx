import { APPOINTMENT_STATUS, cn } from "@/lib/panel/ui";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const meta = APPOINTMENT_STATUS[status] ?? APPOINTMENT_STATUS.scheduled;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        meta.className,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}
