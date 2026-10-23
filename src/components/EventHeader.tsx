import { CalendarDays, MapPin } from "lucide-react";
import type { PublicEvent } from "@/hooks/useEvent";
import { STATUS_LABELS } from "@/lib/options";
import { formatInTz, tzAbbrev } from "@/lib/time";
import { Badge } from "./ui/misc";

export function EventStatusBadge({ status, paused }: { status: string; paused?: boolean }) {
  if (paused) return <Badge tone="red">Paused</Badge>;
  const tone = status === "registration_open" ? "green" : status === "primary_revealed" || status === "recommendations_available" ? "gold" : "neutral";
  return <Badge tone={tone as any}>{STATUS_LABELS[status] ?? status}</Badge>;
}

export function EventHeader({ event, children }: { event: PublicEvent; children?: React.ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-b-3xl bg-navy-900 text-cream-50 md:rounded-3xl"
      style={event.accent_color ? { boxShadow: `inset 0 -4px 0 ${event.accent_color}` } : undefined}>
      <div aria-hidden className="absolute inset-0 [background:radial-gradient(80%_70%_at_100%_0%,rgba(212,168,75,.35),transparent_60%)]" />
      <div className="relative px-6 pb-8 pt-8">
        <EventStatusBadge status={event.status} paused={event.is_paused} />
        <h1 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">{event.name}</h1>
        {event.tagline && <p className="mt-1 text-navy-100">{event.tagline}</p>}
        <div className="mt-4 space-y-1.5 text-sm text-navy-100">
          <p className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-gold-300" aria-hidden />
            {formatInTz(event.starts_at, event.timezone)} – {formatInTz(event.ends_at, event.timezone, { weekday: undefined, day: undefined, month: undefined })}
            <span className="text-navy-300">({tzAbbrev(event.timezone)})</span></p>
          {event.venue_name && <p className="flex items-center gap-2"><MapPin className="h-4 w-4 text-gold-300" aria-hidden />{event.venue_name}{event.venue_address ? `, ${event.venue_address}` : ""}</p>}
        </div>
        {children}
      </div>
    </section>
  );
}
