import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, Users } from "lucide-react";
import { rpc } from "@/lib/api";
import { formatInTz } from "@/lib/time";
import { EventStatusBadge } from "@/components/EventHeader";
import { Button } from "@/components/ui/button";
import { EmptyState, Spinner } from "@/components/ui/misc";

interface OrgEvent { id: string; slug: string; name: string; status: string; is_paused: boolean; starts_at: string | null; timezone: string; venue_name: string | null; registered: number; role: string }

export default function OrganiserHome() {
  const q = useQuery({ queryKey: ["organiser_events"], queryFn: () => rpc<OrgEvent[]>("organiser_events") });
  return (
    <div className="page-wide">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="eyebrow">Organiser</p><h1 className="mt-1 text-3xl font-semibold">Your events</h1></div>
        <Button asChild variant="gold"><Link to="/organiser/events/new"><Plus className="h-4 w-4" />New event</Link></Button>
      </div>
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {q.isLoading ? <Spinner /> : !q.data?.length ? (
          <div className="md:col-span-2"><EmptyState title="No events yet" action={<Button asChild><Link to="/organiser/events/new">Create your first event</Link></Button>}>Set up the schedule, share the QR code and let Meetwise handle the introductions.</EmptyState></div>
        ) : q.data.map((e) => (
          <Link key={e.id} to={`/organiser/events/${e.id}`} className="card flex items-center gap-4 p-5 transition hover:shadow-glow">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="truncate text-lg font-semibold">{e.name}</span><EventStatusBadge status={e.status} paused={e.is_paused} /></div>
              <p className="mt-0.5 text-sm text-navy-500">{e.starts_at ? formatInTz(e.starts_at, e.timezone) : "No date yet"}{e.venue_name ? ` · ${e.venue_name}` : ""}</p>
              <p className="mt-1 flex items-center gap-1 text-sm text-navy-600"><Users className="h-4 w-4" aria-hidden />{e.registered} registered{e.role === "co_organiser" ? " · co-organiser" : ""}</p>
            </div>
            <ChevronRight className="h-5 w-5 text-navy-300" aria-hidden />
          </Link>
        ))}
      </div>
    </div>
  );
}
