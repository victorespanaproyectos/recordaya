import { cn } from "@/lib/panel/ui";

/** Isotipo (reloj + check) y nombre. */
export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg viewBox="0 0 1024 1024" aria-hidden className="size-8 shrink-0">
        <rect width="1024" height="1024" rx="240" fill="var(--brand)" />
        <circle cx="512" cy="540" r="290" fill="none" stroke="var(--brand-fg)" strokeWidth="64" />
        <path d="M512 380v170l110 70" fill="none" stroke="var(--brand-fg)" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M300 230l-70 60M724 230l70 60" stroke="var(--brand-fg)" strokeWidth="64" strokeLinecap="round" />
      </svg>
      {withText && (
        <span className="text-lg font-bold tracking-tight">
          Recorda<span className="text-brand">Ya</span>
        </span>
      )}
    </span>
  );
}
