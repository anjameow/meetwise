import * as React from "react";
import { TIMEZONES } from "@/lib/options";
import { toLocalInput } from "@/lib/time";
import { Button } from "./ui/button";
import { Field, Input, Select, Switch, Textarea } from "./ui/form";
import { Card, ErrorNote } from "./ui/misc";

export interface EventRow {
  id?: string; name: string; tagline: string | null; description: string | null; venue_name: string | null; venue_address: string | null;
  timezone: string; accent_color: string | null; starts_at: string | null; ends_at: string | null; registration_opens_at: string | null;
  registration_deadline: string | null; primary_reveal_at: string | null; post_event_reveal_at: string | null; capacity: number | null;
  access_code: string | null; allow_late_registration: boolean; allowed_email_domains: string[]; status?: string;
}

const TIME_KEYS = ["registration_opens_at", "registration_deadline", "starts_at", "primary_reveal_at", "ends_at", "post_event_reveal_at"] as const;
type TimeKey = (typeof TIME_KEYS)[number];

export type EventPayload = Record<string, unknown>;

/** Times are edited as wall-clock in the event's timezone and converted by the server. */
export function EventForm({ initial, onSubmit, submitLabel, busy }: {
  initial?: EventRow; onSubmit: (p: EventPayload) => void; submitLabel: string; busy?: boolean;
}) {
  const tz0 = initial?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const [f, setF] = React.useState(() => ({
    name: initial?.name ?? "", tagline: initial?.tagline ?? "", description: initial?.description ?? "",
    venue_name: initial?.venue_name ?? "", venue_address: initial?.venue_address ?? "", timezone: tz0,
    accent_color: initial?.accent_color ?? "#D4A84B", capacity: initial?.capacity ? String(initial.capacity) : "",
    access_code: initial?.access_code ?? "", allow_late_registration: initial?.allow_late_registration ?? true,
    allowed_email_domains: (initial?.allowed_email_domains ?? []).join(", "),
    ...Object.fromEntries(TIME_KEYS.map((k) => [k, toLocalInput(initial?.[k] ?? null, tz0)])) as Record<TimeKey, string>,
  }));
  const [error, setError] = React.useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = (k: TimeKey) => (f[k] ? new Date(f[k]).getTime() : null); // same tz for all, so ordering is valid
    const order: Array<[TimeKey, TimeKey, string]> = [
      ["registration_opens_at", "registration_deadline", "Registration must open before it closes."],
      ["registration_deadline", "primary_reveal_at", "The match reveal must be at or after the registration deadline."],
      ["starts_at", "ends_at", "The event must end after it starts."],
      ["primary_reveal_at", "ends_at", "The match reveal must be before the event ends."],
      ["ends_at", "post_event_reveal_at", "Recommendations are revealed after the event ends."],
    ];
    for (const [a, b, msg] of order) { const x = t(a), y = t(b); if (x !== null && y !== null && x > y) return setError(msg); }
    if (f.name.trim().length < 3) return setError("Give the event a name (3+ characters).");
    if (f.access_code && !/^[A-Za-z0-9-]{4,32}$/.test(f.access_code)) return setError("Access codes are 4–32 letters, numbers or dashes.");
    setError(null);
    onSubmit({
      name: f.name, tagline: f.tagline, description: f.description, venue_name: f.venue_name, venue_address: f.venue_address,
      timezone: f.timezone, accent_color: f.accent_color, capacity: f.capacity ? Number(f.capacity) : null,
      access_code: f.access_code, allow_late_registration: f.allow_late_registration,
      allowed_email_domains: f.allowed_email_domains.split(",").map((d) => d.trim().replace(/^@/, "")).filter(Boolean),
      ...Object.fromEntries(TIME_KEYS.map((k) => [k, f[k] || null])),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-semibold">The basics</h2>
        <Field label="Event name" htmlFor="ev-name"><Input id="ev-name" maxLength={120} value={f.name} onChange={(e) => set({ name: e.target.value })} required /></Field>
        <Field label="Tagline" htmlFor="ev-tag" optional><Input id="ev-tag" maxLength={140} value={f.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Field>
        <Field label="Description" htmlFor="ev-desc" optional><Textarea id="ev-desc" maxLength={4000} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Venue" htmlFor="ev-venue" optional><Input id="ev-venue" maxLength={120} value={f.venue_name} onChange={(e) => set({ venue_name: e.target.value })} /></Field>
          <Field label="Address" htmlFor="ev-addr" optional><Input id="ev-addr" maxLength={300} value={f.venue_address} onChange={(e) => set({ venue_address: e.target.value })} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Accent colour" htmlFor="ev-color" hint="Used for subtle branding on the event page">
            <div className="flex items-center gap-2"><input id="ev-color" type="color" value={f.accent_color} onChange={(e) => set({ accent_color: e.target.value.toUpperCase() })} className="h-12 w-16 rounded-xl border border-navy-200" /><span className="font-mono text-sm">{f.accent_color}</span></div>
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-semibold">Schedule</h2>
        <Field label="Event timezone" htmlFor="ev-tz" hint="All times below are in this timezone. Attendees see it too."><Select id="ev-tz" options={TIMEZONES} value={f.timezone} onValueChange={(v) => set({ timezone: v || "UTC" })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <TimeField label="Registration opens" k="registration_opens_at" f={f} set={set} optional />
          <TimeField label="Registration deadline" k="registration_deadline" f={f} set={set} />
          <TimeField label="Event starts" k="starts_at" f={f} set={set} />
          <TimeField label="Event ends" k="ends_at" f={f} set={set} />
          <TimeField label="Primary match reveal" k="primary_reveal_at" f={f} set={set} />
          <TimeField label="Recommendations reveal" k="post_event_reveal_at" f={f} set={set} />
        </div>
        <p className="text-sm text-navy-500">Matching runs automatically when registration closes; matches stay hidden until the reveal time.</p>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-lg font-semibold">Registration rules</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Capacity" htmlFor="ev-cap" optional><Input id="ev-cap" type="number" min={2} inputMode="numeric" value={f.capacity} onChange={(e) => set({ capacity: e.target.value })} /></Field>
          <Field label="Access code" htmlFor="ev-code" optional hint="Share at the venue to keep the link private"><Input id="ev-code" maxLength={32} value={f.access_code} onChange={(e) => set({ access_code: e.target.value })} /></Field>
        </div>
        <Field label="Allowed email domains" htmlFor="ev-dom" optional hint="Comma separated, e.g. upenn.edu"><Input id="ev-dom" value={f.allowed_email_domains} onChange={(e) => set({ allowed_email_domains: e.target.value })} /></Field>
        <Switch checked={f.allow_late_registration} onChange={(v) => set({ allow_late_registration: v })} label="Allow late arrivals"
          description="People can still join after the deadline; they're matched together in late-arrival rounds." />
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" size="lg" loading={busy} className="w-full sm:w-auto">{submitLabel}</Button>
    </form>
  );
}

function TimeField({ label, k, f, set, optional }: { label: string; k: TimeKey; f: Record<string, any>; set: (p: any) => void; optional?: boolean }) {
  return (
    <Field label={label} htmlFor={`t-${k}`} optional={optional}>
      <Input id={`t-${k}`} type="datetime-local" value={f[k]} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );
}
