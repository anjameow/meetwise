import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Download, ExternalLink } from "lucide-react";
import QRCode from "qrcode";
import { rpc } from "@/lib/api";
import { errorCode, friendlyError } from "@/lib/errors";
import { GOALS, INDUSTRIES, labelOf } from "@/lib/options";
import { formatInTz, relativeTime, tzAbbrev } from "@/lib/time";
import { EventForm, type EventPayload, type EventRow } from "@/components/EventForm";
import { EventStatusBadge } from "@/components/EventHeader";
import { Button } from "@/components/ui/button";
import { Card, ConfirmDialog, EmptyState, ErrorNote, Spinner, Stat, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { MatchingTab } from "./MatchingTab";
import { AttendeesTab } from "./AttendeesTab";

export interface Detail {
  event: EventRow & { id: string; slug: string; status: string; is_paused: boolean; matching_weights: Record<string, number>; role_rules: Record<string, any>; recommendations_generated_at: string | null };
  server_now: string;
  counts: Record<string, number>;
  organisers: Array<{ user_id: string; role: string; full_name: string | null; email: string }>;
  rounds: Array<{ id: string; round_number: number; mode: string; status: string; eligible_count: number; matched_pairs: number; unmatched_count: number; algorithm: string | null; error: string | null; started_at: string; completed_at: string | null }>;
  primary_revealed: boolean; recommendations_revealed: boolean; recommendation_count: number;
}

export default function OrganiserEvent() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ["org_event", id], queryFn: () => rpc<Detail>("organiser_event_detail", { p_event: id }), refetchInterval: 20_000 });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <div className="page"><EmptyState title="Can't open this event">{friendlyError(q.error)}</EmptyState></div>;
  const d = q.data!; const e = d.event;
  return (
    <div className="page-wide">
      <Link to="/organiser" className="text-sm text-navy-500 hover:underline">← All events</Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold">{e.name}</h1>
        <EventStatusBadge status={e.status} paused={e.is_paused} />
      </div>
      <Tabs defaultValue="overview" className="mt-5">
        <TabsList>
          {["overview", "details", "attendees", "matching", "analytics", "share", "activity"].map((t) => <TabsTrigger key={t} value={t} className="capitalize">{t}</TabsTrigger>)}
        </TabsList>
        <div className="mt-5">
          <TabsContent value="overview"><Overview d={d} refetch={q.refetch} /></TabsContent>
          <TabsContent value="details"><Details d={d} refetch={q.refetch} /></TabsContent>
          <TabsContent value="attendees"><AttendeesTab eventId={e.id} /></TabsContent>
          <TabsContent value="matching"><MatchingTab d={d} refetch={q.refetch} /></TabsContent>
          <TabsContent value="analytics"><Analytics eventId={e.id} /></TabsContent>
          <TabsContent value="share"><Share slug={e.slug} name={e.name} /></TabsContent>
          <TabsContent value="activity"><Activity eventId={e.id} /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

const ACTIONS: Record<string, { label: string; desc: string; danger?: boolean }> = {
  publish: { label: "Publish & open registration", desc: "Attendees can join via the link and QR code." },
  close_registration: { label: "Close registration now", desc: "Moves the deadline to now. Matching will run automatically." },
  reopen_registration: { label: "Reopen registration", desc: "Only possible before matching has run and while the deadline is in the future." },
  pause: { label: "Pause event", desc: "Blocks registration and holds all reveals until you resume.", danger: true },
  resume: { label: "Resume event", desc: "Reveals that are due will happen immediately." },
  end: { label: "End event now", desc: "Stops late-arrival matching. Recommendations release at the scheduled time.", danger: true },
  archive: { label: "Archive event", desc: "Archived events are read-only and hidden from attendees.", danger: true },
};

function availableActions(e: Detail["event"]) {
  if (e.status === "archived") return [];
  const a: string[] = [];
  if (e.status === "draft") a.push("publish");
  if (e.status === "registration_open") a.push("close_registration");
  if (e.status === "registration_closed") a.push("reopen_registration");
  if (e.status !== "draft") a.push(e.is_paused ? "resume" : "pause");
  if (!["draft", "event_ended", "recommendations_available"].includes(e.status)) a.push("end");
  a.push("archive");
  return a;
}

function Overview({ d, refetch }: { d: Detail; refetch: () => void }) {
  const nav = useNavigate();
  const e = d.event; const c = d.counts; const tz = tzAbbrev(e.timezone);
  const [pending, setPending] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const run = async (action: string) => {
    setBusy(true);
    try {
      await rpc("set_event_status", { p_event: e.id, p_action: action, p_confirm: action !== "publish" });
      toast.success("Updated"); refetch();
    } catch (err) { toast.error(friendlyError(err)); } finally { setBusy(false); setPending(null); }
  };
  const duplicate = async () => {
    try { const r = await rpc<{ id: string }>("duplicate_event", { p_event: e.id }); toast.success("Duplicated as a new draft"); nav(`/organiser/events/${r.id}`); }
    catch (err) { toast.error(friendlyError(err)); }
  };
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Registered" value={c.registered} hint={`${c.checked_in} checked in`} />
        <Stat label="Profiles complete" value={c.profiles_complete} hint={`of ${c.registered}`} />
        <Stat label="Eligible to match" value={c.eligible} hint={`${c.matching_consent} consented`} />
        <Stat label="Matched" value={c.matched} hint={`${c.unmatched_eligible} unmatched · ${c.awaiting_match} waiting`} />
        <Stat label="Late arrivals" value={c.late} />
        <Stat label="Withdrawn" value={c.withdrawn} hint={`${c.removed} removed`} />
        <Stat label="Recs opt-in" value={c.recommendations_opt_in} />
        <Stat label="Recommendations" value={d.recommendation_count} hint={d.recommendations_revealed ? "Revealed" : e.recommendations_generated_at ? "Ready, hidden" : "Not generated"} />
      </div>
      <Card className="p-5">
        <h2 className="text-lg font-semibold">Schedule <span className="text-sm font-normal text-navy-400">({e.timezone}{tz !== e.timezone ? ` · ${tz}` : ""})</span></h2>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[["Registration deadline", e.registration_deadline], ["Event starts", e.starts_at], ["Primary reveal", e.primary_reveal_at], ["Event ends", e.ends_at], ["Recommendations reveal", e.post_event_reveal_at]].map(([l, v]) => (
            <div key={l as string} className="flex justify-between gap-3 border-b border-navy-50 pb-2"><dt className="text-navy-500">{l}</dt><dd className="font-semibold">{formatInTz(v as string, e.timezone)}</dd></div>
          ))}
        </dl>
      </Card>
      <Card className="p-5">
        <h2 className="text-lg font-semibold">Lifecycle</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {availableActions(e).map((a) => (
            <Button key={a} variant={a === "publish" ? "gold" : ACTIONS[a].danger ? "outline" : "primary"} onClick={() => setPending(a)}>{ACTIONS[a].label}</Button>
          ))}
          <Button variant="outline" onClick={duplicate}>Duplicate</Button>
          {e.status !== "draft" && <Button variant="ghost" asChild><Link to={`/e/${e.slug}`}><ExternalLink className="h-4 w-4" />Attendee view</Link></Button>}
        </div>
      </Card>
      {pending && (
        <ConfirmDialog open onOpenChange={(o) => !o && setPending(null)} title={ACTIONS[pending].label} description={ACTIONS[pending].desc}
          danger={ACTIONS[pending].danger} loading={busy} onConfirm={() => run(pending)} confirmLabel="Confirm" />
      )}
    </div>
  );
}

function Details({ d, refetch }: { d: Detail; refetch: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<EventPayload | null>(null);
  const save = async (p: EventPayload, confirmed = false) => {
    setBusy(true);
    try {
      await rpc("update_event", { p_event: d.event.id, p, p_confirm: confirmed });
      toast.success(confirmed ? "Schedule updated — attendees have been notified." : "Saved"); setConfirm(null); refetch();
    } catch (err) {
      if (errorCode(err) === "confirmation_required") setConfirm(p);
      else toast.error(friendlyError(err));
    } finally { setBusy(false); }
  };
  return (
    <>
      <EventForm key={d.event.id + d.event.status} initial={d.event} onSubmit={(p) => save(p)} submitLabel="Save changes" busy={busy} />
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} title="Change the published schedule?"
        description="Registered attendees will be notified. Reveal times can't move once they've happened." loading={busy}
        confirmLabel="Update schedule" onConfirm={() => confirm && save(confirm, true)} />
    </>
  );
}

function Analytics({ eventId }: { eventId: string }) {
  const q = useQuery({ queryKey: ["analytics", eventId], queryFn: () => rpc<any>("event_analytics", { p_event: eventId }) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote>{friendlyError(q.error)}</ErrorNote>;
  const a = q.data; const f = a.feedback;
  const bar = (obj: Record<string, number>, labels: typeof GOALS) => {
    const entries = Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, 8);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.length ? (
      <ul className="space-y-2">{entries.map(([k, v]) => (
        <li key={k} className="text-sm"><div className="flex justify-between"><span>{labelOf(labels, k) || k}</span><span className="font-semibold tabular-nums">{v}</span></div>
          <div className="mt-1 h-2 rounded-full bg-navy-50"><div className="h-2 rounded-full bg-navy-700" style={{ width: `${(v / max) * 100}%` }} /></div></li>
      ))}</ul>
    ) : <p className="text-sm text-navy-400">No data yet.</p>;
  };
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Avg match score" value={a.avg_match_score ?? "—"} />
        <Stat label="Feedback responses" value={f.responses} />
        <Stat label="Avg match rating" value={f.avg_match_rating ?? "—"} hint="out of 5" />
        <Stat label="Met in person" value={f.met_in_person_rate != null ? `${Math.round(f.met_in_person_rate * 100)}%` : "—"} />
        <Stat label="Event rating" value={f.avg_event_rating ?? "—"} hint="out of 5" />
        <Stat label="Connections made" value={a.connections_made} hint={`${a.mentorships_made} mentorships`} />
        <Stat label="Requests" value={a.requests_sent} hint={`${a.requests_accepted} accepted`} />
        <Stat label="Profiles saved" value={a.profiles_saved} />
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <Card className="p-5"><h3 className="mb-3 font-semibold">Attendee goals</h3>{bar(a.goals, GOALS)}</Card>
        <Card className="p-5"><h3 className="mb-3 font-semibold">Industries</h3>{bar(a.industries, INDUSTRIES)}</Card>
      </div>
      <Card className="p-5">
        <h3 className="font-semibold">Follow-up choices</h3>
        {a.followup_responses < 5 ? <p className="mt-1 text-sm text-navy-400">Shown once at least 5 attendees respond, to protect individual choices.</p>
          : <p className="mt-2 text-sm">{Object.entries(a.followups).map(([k, v]) => `${k.replace("_", " ")}: ${v}`).join(" · ")}</p>}
      </Card>
      <Card className="p-5">
        <h3 className="font-semibold">Anonymous comments</h3>
        {a.recent_comments.length ? <ul className="mt-2 space-y-2 text-sm">{a.recent_comments.map((c: string, i: number) => <li key={i} className="rounded-xl bg-cream-100 p-3">“{c}”</li>)}</ul>
          : <p className="mt-1 text-sm text-navy-400">No comments yet.</p>}
      </Card>
      <p className="text-xs text-navy-400">Matching weights are starting hypotheses, not validated measurements. Use feedback here to tune them over time.</p>
    </div>
  );
}

function Share({ slug, name }: { slug: string; name: string }) {
  const url = `${location.origin}/e/${slug}`;
  const [png, setPng] = React.useState<string>("");
  React.useEffect(() => {
    QRCode.toDataURL(url, { width: 1024, margin: 2, color: { dark: "#0E1A3A", light: "#FFFFFF" }, errorCorrectionLevel: "M" }).then(setPng);
  }, [url]);
  const downloadSvg = async () => {
    const svg = await QRCode.toString(url, { type: "svg", margin: 2, color: { dark: "#0E1A3A", light: "#FFFFFF" } });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    a.download = `${slug}-qr.svg`; a.click();
  };
  return (
    <div className="grid gap-5 md:grid-cols-[320px,1fr]">
      <Card className="p-5 text-center">
        {png ? <img src={png} alt={`QR code linking to ${name}`} className="mx-auto w-full max-w-[280px] rounded-xl" /> : <Spinner />}
        <p className="mt-3 font-display text-lg">{name}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button asChild size="sm"><a href={png} download={`${slug}-qr.png`}><Download className="h-4 w-4" />PNG</a></Button>
          <Button size="sm" variant="outline" onClick={downloadSvg}><Download className="h-4 w-4" />SVG</Button>
        </div>
      </Card>
      <Card className="p-5">
        <h3 className="font-semibold">Event link</h3>
        <div className="mt-2 flex gap-2">
          <code className="flex-1 truncate rounded-xl bg-cream-100 px-3 py-2.5 text-sm">{url}</code>
          <Button variant="outline" onClick={() => { navigator.clipboard.writeText(url); toast.success("Link copied"); }}><Copy className="h-4 w-4" />Copy</Button>
        </div>
        <p className="mt-3 text-sm text-navy-500">Print the QR on table cards or show it on screen at the door. If you set an access code, share it at the venue.</p>
      </Card>
    </div>
  );
}

function Activity({ eventId }: { eventId: string }) {
  const q = useQuery({ queryKey: ["audit", eventId], queryFn: () => rpc<any[]>("event_audit_log", { p_event: eventId }) });
  if (q.isLoading) return <Spinner />;
  return (
    <Card className="divide-y divide-navy-100">
      {!q.data?.length ? <p className="p-5 text-sm text-navy-400">No activity yet.</p> : q.data.map((l) => (
        <div key={l.id} className="flex flex-wrap justify-between gap-2 px-5 py-3 text-sm">
          <span><strong>{l.action}</strong>{l.actor ? ` · ${l.actor}` : " · system"}</span>
          <span className="text-navy-400">{relativeTime(l.created_at)}</span>
        </div>
      ))}
    </Card>
  );
}
