import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { Loader2, X } from "lucide-react";
import { cn, initials } from "@/lib/utils";
import { avatarUrl } from "@/lib/api";
import { Button } from "./button";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...p} />;
}

export function Badge({ className, tone = "neutral", ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "gold" | "navy" | "green" | "red" }) {
  const tones = {
    neutral: "bg-navy-50 text-navy-700", gold: "bg-gold-100 text-gold-600", navy: "bg-navy-900 text-cream-50",
    green: "bg-emerald-50 text-emerald-800", red: "bg-red-50 text-red-800",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold", tones[tone], className)} {...p} />;
}

export function Progress({ value, className, label }: { value: number; className?: string; label?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-navy-100", className)}>
      <div className="h-full rounded-full bg-gradient-to-r from-gold-400 to-gold-300 transition-all duration-500" style={{ width: `${value}%` }} />
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-16 text-navy-400" role="status">
      <Loader2 className="h-6 w-6 animate-spin" aria-hidden /><span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-navy-200 bg-white/60 px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-gold-100 p-3 text-gold-600">{icon}</div>}
      <h3 className="text-lg font-semibold">{title}</h3>
      {children && <div className="mt-1 max-w-sm text-sm text-navy-500">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{children}</div>;
}

export function Avatar({ name, path, size = 48, className }: { name?: string | null; path?: string | null; size?: number; className?: string }) {
  const url = avatarUrl(path);
  return url ? (
    <img src={url} alt="" width={size} height={size} className={cn("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />
  ) : (
    <div aria-hidden className={cn("flex shrink-0 items-center justify-center rounded-full bg-navy-800 font-display font-semibold text-gold-300", className)}
      style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials(name)}</div>
  );
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, className }: { title: string; description?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-navy-950/50 backdrop-blur-sm data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content className={cn("fixed inset-x-0 bottom-0 z-50 max-h-[90vh] overflow-y-auto rounded-t-3xl bg-cream-50 p-6 shadow-2xl data-[state=open]:animate-reveal-up sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl", className)}>
        <DialogPrimitive.Title className="pr-8 font-display text-xl font-semibold">{title}</DialogPrimitive.Title>
        {description && <DialogPrimitive.Description className="mt-1 text-sm text-navy-500">{description}</DialogPrimitive.Description>}
        <div className="mt-4">{children}</div>
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-full p-2 text-navy-400 hover:bg-navy-50" aria-label="Close"><X className="h-5 w-5" /></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Explicit confirmation for consequential actions. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", danger, onConfirm, loading, requireText }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: React.ReactNode; confirmLabel?: string;
  danger?: boolean; onConfirm: () => void; loading?: boolean; requireText?: string;
}) {
  const [typed, setTyped] = React.useState("");
  React.useEffect(() => { if (!open) setTyped(""); }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {requireText && (
          <div className="mb-4">
            <label className="text-sm text-navy-600" htmlFor="confirm-text">Type <strong>{requireText}</strong> to confirm</label>
            <input id="confirm-text" value={typed} onChange={(e) => setTyped(e.target.value)}
              className="mt-1 h-11 w-full rounded-xl border border-navy-200 px-3" autoComplete="off" />
          </div>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={loading} disabled={!!requireText && typed !== requireText} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const Tabs = TabsPrimitive.Root;
export function TabsList({ className, ...p }: TabsPrimitive.TabsListProps) {
  return <TabsPrimitive.List className={cn("no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 pb-1", className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: TabsPrimitive.TabsTriggerProps) {
  return <TabsPrimitive.Trigger className={cn("shrink-0 rounded-full px-4 py-2 text-sm font-semibold text-navy-500 transition hover:text-navy-900 data-[state=active]:bg-navy-900 data-[state=active]:text-cream-50", className)} {...p} />;
}
export const TabsContent = TabsPrimitive.Content;

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-navy-100 bg-white p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-navy-400">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold text-navy-900">{value}</div>
      {hint && <div className="text-xs text-navy-400">{hint}</div>}
    </div>
  );
}
