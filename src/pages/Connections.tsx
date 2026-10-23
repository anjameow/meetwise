import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bookmark, Inbox, Users } from "lucide-react";
import { invoke, rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { relativeTime } from "@/lib/time";
import { ProfileCard, type CardProfile } from "@/components/ProfileCard";
import { ConnectButton } from "@/components/ConnectButton";
import { SafetyActions } from "@/components/SafetyActions";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";

interface Req { id: string; kind: string; requester_mentorship_role: string | null; message?: string | null; created_at: string; event_name: string | null; status?: string; profile: CardProfile }
interface Conn { user_id: string; kinds: string[]; mentor_id: string | null; since: string; event_name: string | null; profile: CardProfile; resume_available: boolean }
interface Saved { user_id: string; event_id: string | null; event_name: string | null; profile: CardProfile; request_status: string | null }

export default function Connections() {
  const reqs = useQuery({ queryKey: ["requests"], queryFn: () => rpc<{ incoming: Req[]; outgoing: Req[] }>("my_connection_requests") });
  const conns = useQuery({ queryKey: ["connections"], queryFn: () => rpc<Conn[]>("my_connections") });
  const saved = useQuery({ queryKey: ["saved"], queryFn: () => rpc<Saved[]>("my_saved_profiles") });
  const refresh = () => { reqs.refetch(); conns.refetch(); saved.refetch(); };

  const respond = async (id: string, accept: boolean) => {
    try {
      await rpc("respond_connection_request", { p_request: id, p_accept: accept });
      toast.success(accept ? "Connected! Contact details unlocked." : "Request dismissed. They won't be notified.");
      refresh();
    } catch (e) { toast.error(friendlyError(e)); }
  };
  const openResume = async (owner: string) => {
    try { const { url } = await invoke<{ url: string }>("resume-url", { owner_id: owner }); window.open(url, "_blank", "noopener,noreferrer"); }
    catch (e) { toast.error(friendlyError(e)); }
  };
  const incoming = reqs.data?.incoming ?? [];

  return (
    <div className="page">
      <h1 className="text-3xl font-semibold">People</h1>
      <Tabs defaultValue={incoming.length ? "requests" : "connections"} className="mt-5">
        <TabsList>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="requests">Requests{incoming.length ? ` (${incoming.length})` : ""}</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
        </TabsList>

        <TabsContent value="connections" className="mt-5 space-y-5">
          {conns.isLoading ? <Spinner /> : !conns.data?.length ? (
            <EmptyState icon={<Users className="h-6 w-6" />} title="No connections yet">When you and someone both want to stay in touch, they'll appear here with the contact details they chose to share.</EmptyState>
          ) : conns.data.map((c) => (
            <ProfileCard key={c.user_id} p={{ ...c.profile, resume_available: c.resume_available }} onResume={() => openResume(c.user_id)}
              highlight={<div className="flex flex-wrap gap-1.5">
                {c.kinds.includes("mentorship") && <Badge tone="gold">{c.mentor_id === c.user_id ? "Your mentor" : "You mentor them"}</Badge>}
                <Badge>Connected {relativeTime(c.since)}{c.event_name ? ` · ${c.event_name}` : ""}</Badge>
              </div>}
              footer={<div className="flex flex-wrap justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={async () => { await rpc("remove_connection", { p_user: c.user_id }); refresh(); }}>Remove connection</Button>
                <SafetyActions userId={c.user_id} name={c.profile.first_name || "them"} onBlocked={refresh} />
              </div>} />
          ))}
        </TabsContent>

        <TabsContent value="requests" className="mt-5 space-y-5">
          {reqs.isLoading ? <Spinner /> : (<>
            {incoming.length === 0 && <EmptyState icon={<Inbox className="h-6 w-6" />} title="No pending requests">Requests from people you were introduced to show up here.</EmptyState>}
            {incoming.map((r) => (
              <ProfileCard key={r.id} p={r.profile} variant="compact"
                highlight={<div className="rounded-2xl bg-cream-100 p-4 text-sm">
                  <p className="font-semibold">{r.kind === "mentorship" ? (r.requester_mentorship_role === "mentor" ? "Offers to mentor you" : "Would love your mentorship") : "Wants to connect"}{r.event_name ? ` · ${r.event_name}` : ""}</p>
                  {r.message && <p className="mt-1 text-navy-700">“{r.message}”</p>}
                </div>}
                footer={<div className="flex flex-wrap justify-between gap-2">
                  <div className="flex gap-2"><Button size="sm" variant="gold" onClick={() => respond(r.id, true)}>Accept</Button><Button size="sm" variant="outline" onClick={() => respond(r.id, false)}>Not now</Button></div>
                  <SafetyActions userId={r.profile.id} name={r.profile.first_name || "them"} onBlocked={refresh} />
                </div>} />
            ))}
            {!!reqs.data?.outgoing.length && (
              <section>
                <h2 className="mb-2 mt-4 text-lg font-semibold">Sent</h2>
                <ul className="card divide-y divide-navy-100">
                  {reqs.data.outgoing.map((r) => (
                    <li key={r.id} className="flex items-center justify-between px-5 py-3 text-sm">
                      <span><strong>{r.profile.full_name}</strong> · {r.kind === "mentorship" ? "mentorship" : "connection"}</span>
                      <span className="flex items-center gap-2">
                        <Badge tone={r.status === "accepted" ? "green" : "neutral"}>{r.status === "accepted" ? "Accepted" : "Pending"}</Badge>
                        {r.status !== "accepted" && <button className="text-navy-400 underline" onClick={async () => { await rpc("cancel_connection_request", { p_request: r.id }); refresh(); }}>Withdraw</button>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>)}
        </TabsContent>

        <TabsContent value="saved" className="mt-5 space-y-5">
          {saved.isLoading ? <Spinner /> : !saved.data?.length ? (
            <EmptyState icon={<Bookmark className="h-6 w-6" />} title="Nothing saved yet">Save recommendations to come back to them later.</EmptyState>
          ) : saved.data.map((s) => (
            <ProfileCard key={s.user_id} p={s.profile} variant="compact"
              footer={<div className="flex flex-wrap justify-between gap-2">
                <div className="flex gap-2">
                  <ConnectButton userId={s.user_id} name={s.profile.first_name || "them"} eventId={s.event_id} status={s.request_status} onChange={refresh} />
                  <Button size="sm" variant="ghost" onClick={async () => { await rpc("unsave_profile", { p_user: s.user_id }); refresh(); }}>Unsave</Button>
                </div>
                {s.event_name && <span className="self-center text-xs text-navy-400">From {s.event_name}</span>}
              </div>} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
