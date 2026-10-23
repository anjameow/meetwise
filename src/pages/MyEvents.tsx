import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarHeart, ChevronRight, QrCode } from "lucide-react";
import { rpc } from "@/lib/api";
import { formatInTz } from "@/lib/time";
import { EventStatusBadge } from "@/components/EventHeader";
import { EmptyState, Spinner } from "@/components/ui/misc";
import type { PublicEvent } from "@/hooks/useEvent";

type MyEvent = PublicEvent & { registration_status: string };

export default function MyEvents() {
  const q = useQuery({ queryKey: ["my_events"], queryFn: () => rpc<MyEvent[]>("my_events") });
  return (
    <div className="page">
      <h1 className="text-3xl font-semibold">Your events</h1>
      <div className="mt-5 space-y-3">
        {q.isLoading ? <Spinner /> : !q.data?.length ? (
          <EmptyState icon={<QrCode className="h-6 w-6" />} title="No events yet">Scan the QR code at your next event, or open the link the organiser shared.</EmptyState>
        ) : q.data.map((e) => {
          const active = ["registered", "checked_in"].includes(e.registration_status);
          return (
            <Link key={e.id} to={active ? `/e/${e.slug}/hub` : `/e/${e.slug}`} className="card flex items-center gap-4 p-4 transition hover:shadow-glow">
              <div className="rounded-xl bg-navy-900 p-3 text-gold-300"><CalendarHeart className="h-5 w-5" aria-hidden /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="truncate font-semibold">{e.name}</span><EventStatusBadge status={e.status} paused={e.is_paused} /></div>
                <p className="text-sm text-navy-500">{formatInTz(e.starts_at, e.timezone)}{e.venue_name ? ` · ${e.venue_name}` : ""}{!active ? " · You left" : ""}</p>
              </div>
              <ChevronRight className="h-5 w-5 text-navy-300" aria-hidden />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
