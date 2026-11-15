import { Check, CheckCheck, Clock3, Ban, TriangleAlert } from "lucide-react";
import { cn, MESSAGE_STATUS } from "@/lib/panel/ui";

/** Indicador al estilo WhatsApp: reloj, ✓, ✓✓ gris, ✓✓ azul, o error. */
export function MessageTicks({
  status,
  withLabel = false,
  className,
}: {
  status: string;
  withLabel?: boolean;
  className?: string;
}) {
  const meta = MESSAGE_STATUS[status] ?? MESSAGE_STATUS.accepted;
  const icon = {
    queued: <Clock3 className="size-3.5" />,
    accepted: <Check className="size-3.5" />,
    sent: <Check className="size-3.5" />,
    delivered: <CheckCheck className="size-3.5" />,
    read: <CheckCheck className="size-3.5" />,
    failed: <TriangleAlert className="size-3.5" />,
    cancelled: <Ban className="size-3.5" />,
  }[status] ?? <Check className="size-3.5" />;

  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", meta.className, className)}>
      {icon}
      {withLabel && meta.label}
    </span>
  );
}
