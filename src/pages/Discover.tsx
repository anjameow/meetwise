import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bookmark, BookmarkCheck, Compass, Lightbulb } from "lucide-react";
import { useEventBySlug } from "@/hooks/useEvent";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { formatInTz } from "@/lib/time";
import { Countdown } from "@/components/Countdown";
import { ConnectButton } from "@/components/ConnectButton";
import { ProfileCard, type CardProfile } from "@/components/ProfileCard";
import { SafetyActions } from "@/components/SafetyActions";
import { Button } from "@/components/ui/button";
import { EmptyState, Spinner } from "@/components/ui/misc";

interface Recs {
  state: "not_registered" | "not_opted_in" | "waiting" | "available"; server_now: string; reveal_at?: string; paused?: boolean;
  items?: Array<{ user_id: string; rank: number; reasons: string[]; profile: CardProfile; saved: boolean; request_status: string | null; incoming_request_id: string | null }>;
}

export default function Discover() {
  const { slug } = useParams();
  const ev = useEventBySlug(slug);
  const eventId = ev.data?.event.id;
  const q = useQuery({ queryKey: ["recs", eventId], enabled: !!eventId, queryFn: () => rpc<Recs>("get_my_recommendations", { p_event: eventId }) });

  if (ev.isLoading || q.isLoading) return <Spinner />;
  if (!ev.data) return <Navigate to="/events" replace />;
  if (q.error) return <div className="page"><EmptyState title="Couldn't load recommendations">{friendlyError(q.error)}</EmptyState></div>;
  const r = q.data!; const e = ev.data.event;
  if (r.state === "not_registered") return <Navigate to={`/e/${slug}`} replace />;

  if (r.state === "not_opted_in") {
    return <div className="page"><EmptyState icon={<Compass className="h-6 w-6" />} title="Recommendations are off"
      action={<Button asChild><Link to={`/e/${slug}/hub`}>Turn them on</Link></Button>}>
      You opted out of post-event recommendations for this event. Turn them on to see — and be seen by — up to five more people.</EmptyState></div>;
  }
  if (r.state === "waiting") {
    return (
      <div className="page">
        <div className="rounded-3xl bg-navy-900 p-8 text-center text-cream-50">
          <Compass className="mx-auto h-8 w-8 text-gold-300" aria-hidden />
          <h1 className="mt-3 text-2xl font-semibold">Five more people, soon</h1>
          <p className="mt-2 text-navy-100">{r.paused ? "The organiser has paused this event." : `Revealed ${formatInTz(r.reveal_at, e.timezone)}.`}</p>
          {!r.paused && <div className="mt-6"><Countdown target={r.reveal_at} serverNow={r.server_now} onElapsed={() => q.refetch()} label="Time until recommendations" /></div>}
        </div>
      </div>
    );
  }

  const items = r.items ?? [];
  const toggleSave = async (userId: string, saved: boolean) => {
    try {
      await rpc(saved ? "unsave_profile" : "save_profile", saved ? { p_user: userId } : { p_user: userId, p_event: e.id });
      q.refetch();
    } catch (err) { toast.error(friendlyError(err)); }
  };
  const accept = async (requestId: string) => {
    try { await rpc("respond_connection_request", { p_request: requestId, p_accept: true }); toast.success("Connected!"); q.refetch(); }
    catch (err) { toast.error(friendlyError(err)); }
  };

  return (
    <div className="page space-y-6">
      <div>
        <p className="eyebrow">After {e.name}</p>
        <h1 className="mt-1 text-3xl font-semibold">{items.length === 0 ? "Recommendations" : `${items.length} ${items.length === 1 ? "person" : "people"} worth knowing`}</h1>
        <p className="mt-1 text-navy-500">Ranked by career relevance, complementary goals and shared interests.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState icon={<Compass className="h-6 w-6" />} title="No recommendations this time">
          There weren't enough opted-in attendees with a strong fit. We'd rather show nobody than the wrong people.
        </EmptyState>
      ) : items.map((it, i) => (
        <div key={it.user_id} className="animate-reveal-up" style={{ animationDelay: `${i * 90}ms` }}>
          <ProfileCard p={it.profile} variant="compact"
            highlight={it.reasons.length > 0 && (
              <ul className="space-y-1 text-sm text-navy-700">
                {it.reasons.map((x) => <li key={x} className="flex gap-2"><Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-gold-500" aria-hidden />{x}</li>)}
              </ul>
            )}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">
                  {it.incoming_request_id ? <Button size="sm" variant="gold" onClick={() => accept(it.incoming_request_id!)}>Accept their request</Button>
                    : <ConnectButton userId={it.user_id} name={it.profile.first_name || "them"} eventId={e.id} status={it.request_status} onChange={() => q.refetch()} />}
                  <Button size="sm" variant="outline" onClick={() => toggleSave(it.user_id, it.saved)} aria-pressed={it.saved}>
                    {it.saved ? <BookmarkCheck className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}{it.saved ? "Saved" : "Save"}
                  </Button>
                </div>
                <SafetyActions userId={it.user_id} name={it.profile.first_name || "this person"} eventId={e.id} onBlocked={() => q.refetch()} />
              </div>
            } />
        </div>
      ))}
    </div>
  );
}
