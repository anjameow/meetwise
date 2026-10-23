import * as React from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Option } from "@/lib/options";

const fieldBase =
  "w-full rounded-xl border border-navy-200 bg-white px-4 text-[15px] text-navy-900 placeholder:text-navy-300 transition focus:border-gold-400 focus:outline-none focus:ring-2 focus:ring-gold-200 disabled:bg-cream-100";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(fieldBase, "h-12", className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(fieldBase, "min-h-[96px] py-3", className)} {...props} />,
);
Textarea.displayName = "Textarea";

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  options: Option[] | string[];
  placeholder?: string;
  onValueChange?: (v: string) => void;
}
/** Native select: best keyboard, screen-reader and mobile picker support. */
export function Select({ options, placeholder, className, onValueChange, value, ...props }: SelectProps) {
  const opts = (options as Array<Option | string>).map((x) => (typeof x === "string" ? { value: x, label: x } : x));
  return (
    <select
      className={cn(fieldBase, "h-12 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2216%22 height=%2216%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%231E2A52%22 stroke-width=%222%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[right_1rem_center] bg-no-repeat pr-10", !value && "text-navy-300", className)}
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
      {...props}
    >
      <option value="">{placeholder ?? "Select…"}</option>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Field({ label, hint, error, htmlFor, children, optional, className }: {
  label: string; hint?: React.ReactNode; error?: string | null; htmlFor?: string; children: React.ReactNode; optional?: boolean; className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="flex items-baseline justify-between text-sm font-semibold text-navy-800">
        <span>{label}</span>
        {optional && <span className="text-xs font-normal text-navy-400">Optional</span>}
      </label>
      {children}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : hint ? <p className="text-sm text-navy-400">{hint}</p> : null}
    </div>
  );
}

/** Multi-select chips with an optional maximum. */
export function ChipGroup({ options, value, onChange, max, label }: {
  options: Option[]; value: string[]; onChange: (v: string[]) => void; max?: number; label: string;
}) {
  const toggle = (v: string) => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v));
    else if (!max || value.length < max) onChange([...value, v]);
  };
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o.value);
        const disabled = !on && !!max && value.length >= max;
        return (
          <button key={o.value} type="button" aria-pressed={on} disabled={disabled} onClick={() => toggle(o.value)}
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition",
              on ? "border-navy-900 bg-navy-900 text-cream-50" : "border-navy-200 bg-white text-navy-700 hover:border-navy-400",
              disabled && "opacity-40")}>
            {on && <Check className="h-3.5 w-3.5" aria-hidden />}{o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Free-text tags with suggestions. */
export function TagInput({ value, onChange, suggestions = [], max = 10, placeholder, id }: {
  value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; max?: number; placeholder?: string; id?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const add = (t: string) => {
    const v = t.trim().slice(0, 40);
    if (!v || value.length >= max || value.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    onChange([...value, v]);
    setDraft("");
  };
  const remaining = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 8);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {value.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-gold-100 px-3 py-1.5 text-sm text-navy-900">
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}
              className="rounded-full p-0.5 hover:bg-gold-200"><X className="h-3.5 w-3.5" /></button>
          </span>
        ))}
      </div>
      {value.length < max && (
        <Input id={id} value={draft} placeholder={placeholder ?? "Type and press Enter"} maxLength={40}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); } }}
          onBlur={() => draft && add(draft)} />
      )}
      {remaining.length > 0 && value.length < max && (
        <div className="flex flex-wrap gap-1.5">
          {remaining.map((s) => (
            <button key={s} type="button" onClick={() => add(s)}
              className="rounded-full border border-dashed border-navy-200 px-2.5 py-1 text-xs text-navy-500 hover:border-navy-400 hover:text-navy-800">
              + {s}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-navy-400">{value.length}/{max}</p>
    </div>
  );
}

export function Switch({ checked, onChange, label, description, id }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: React.ReactNode; id?: string;
}) {
  const autoId = React.useId();
  const sid = id ?? autoId;
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <label htmlFor={sid} className="font-semibold text-navy-900">{label}</label>
        {description && <p className="mt-0.5 text-sm text-navy-500">{description}</p>}
      </div>
      <button id={sid} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition", checked ? "bg-navy-900" : "bg-navy-200")}>
        <span className={cn("absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all", checked ? "left-6 bg-gold-300" : "left-1")} />
      </button>
    </div>
  );
}

export function Checkbox({ checked, onChange, children, id }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; id?: string }) {
  const autoId = React.useId();
  const cid = id ?? autoId;
  return (
    <label htmlFor={cid} className="flex cursor-pointer items-start gap-3 rounded-xl border border-navy-100 bg-white p-4 transition hover:border-navy-300">
      <input id={cid} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-navy-300 accent-navy-900" />
      <span className="text-sm text-navy-700">{children}</span>
    </label>
  );
}
