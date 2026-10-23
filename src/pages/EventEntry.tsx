import { Link, useParams } from "react-router-dom";
import { CheckCircle2, Clock } from "lucide-react";
import { useEventBySlug } from "@/hooks/useEvent";
import { useAuth } from "@/hooks/useAuth";
import { EventHeader } from "@/components/EventHeader";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorNote, Spinner } from "@/components/ui/misc";
import { friendlyError } from "@/lib/errors";
import { formatInTz, tzAbbrev } from "@/lib/time";

export default function EventEntry() {
  const { slug } = useParams();
  const { user } = useAuth();
  const q = useEventBySlug(slug);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <div className="page"><EmptyState title="Event not found">{friendlyError(q.error)}</EmptyState></div>;
  const { event, registration, registration_window: win } = q.data!;
  const active = registration && ["registered", "checked_in"].includes(registration.status);
  const tz = tzAbbrev(event.timezone);

  return (
    <div className="mx-auto max-w-2xl md:pt-6">
      <EventHeader event={event} />
      <div className="page space-y-5 pt-6">
        {event.description && <p className="whitespace-pre-line text-navy-700">{event.description}</p>}

        <div className="card divide-y divide-navy-100">
          <Row label="Registration closes" value={`${formatInTz(event.registration_deadline, event.timezone)} ${tz}`} />
          <Row label="Your match is revealed" value={`${formatInTz(event.primary_reveal_at, event.timezone)} ${tz}`} />
          <Row label="Five more recommendations" value={`${formatInTz(event.post_event_reveal_at, event.timezone)} ${tz}`} />
        </div>

        {active ? (
          <div className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 font-semibold text-emerald-800"><CheckCircle2 className="h-5 w-5" aria-hidden />You're registered{registration!.is_late ? " (late arrival)" : ""}</p>
            <Button asChild><Link to={`/e/${event.slug}/hub`}>Go to event</Link></Button>
          </div>
        ) : registration?.status === "removed" ? (
          <ErrorNote>The organiser has removed you from this event.</ErrorNote>
        ) : win === "open" || win === "late" ? (
          <div className="space-y-2">
            {event.is_full ? <ErrorNote>This event is full.</ErrorNote> : (
              <Button asChild size="lg" variant="gold" className="w-full">
                <Link to={user ? `/e/${event.slug}/join` : `/auth?mode=signup&next=${encodeURIComponent(`/e/${event.slug}/join`)}`}>
                  {registration?.status === "withdrawn" ? "Rejoin event" : "Join event"}
                </Link>
              </Button>
            )}
            {win === "late" && <p className="text-center text-sm text-navy-500">Late arrivals are welcome — we'll match you with others who arrive late or are still unmatched.</p>}
          </div>
        ) : (
          <div className="card flex items-center gap-3 p-5 text-navy-600">
            <Clock className="h-5 w-5" aria-hidden />
            {win === "not_open" ? `Registration opens ${formatInTz(event.registration_opens_at, event.timezone)} ${tz}.`
              : win === "paused" ? "This event is paused by the organiser. Check back soon."
              : "Registration for this event is closed."}
          </div>
        )}
        {q.data!.is_organiser && (
          <Button asChild variant="outline" className="w-full"><Link to={`/organiser/events/${event.id}`}>Open organiser dashboard</Link></Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
      <span className="text-navy-500">{label}</span><span className="text-right font-semibold">{value}</span>
    </div>
  );
}
