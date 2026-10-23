import * as React from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CheckCircle2, Hourglass, Sparkles } from "lucide-react";
import { useEventBySlug, type PublicEvent } from "@/hooks/useEvent";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { formatInTz, tzAbbrev } from "@/lib/time";
import { Countdown } from "@/components/Countdown";
import { EventStatusBadge } from "@/components/EventHeader";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/form";
import { Card, ConfirmDialog, EmptyState, ErrorNote, Spinner } from "@/components/ui/misc";

interface Hub {
  event: PublicEvent; server_now: string;
  registration: { status: string; matching_consent: boolean; recommendations_opt_in: boolean; is_late: boolean };
  profile_complete: boolean; ineligible_reasons: string[]; primary_revealed: boolean; recommendations_revealed: boolean;
}

const REASONS: Record<string, string> = {
  profile_incomplete: "Finish your profile so we can match you.",
  no_consent: "You've opted out of matching for this event.",
  suspended: "Your account is suspended.",
  not_active: "Your registration isn't active.",
};

export default function EventHub() {
  const { slug } = useParams();
  const ev = useEventBySlug(slug);
  const qc = useQueryClient();
  const hub = useQuery({
    queryKey: ["hub", ev.data?.event.id],
    enabled: !!ev.data?.registration,
    queryFn: () => rpc<Hub>("get_event_hub", { p_event: ev.data!.event.id }),
    refetchInterval: 60_000,
  });
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  if (ev.isLoading || hub.isLoading) return <Spinner />;
  if (ev.error) return <div className="page"><EmptyState title="Event not found">{friendlyError(ev.error)}</EmptyState></div>;
  if (!ev.data?.registration || ["withdrawn", "removed"].includes(ev.data.registration.status)) return <Navigate to={`/e/${slug}`} replace />;
  if (hub.error || !hub.data) return <div className="page"><ErrorNote>{friendlyError(hub.error)}</ErrorNote></div>;

  const h = hub.data; const e = h.event; const tz = tzAbbrev(e.timezone);
  const refresh = () => { hub.refetch(); qc.invalidateQueries({ queryKey: ["match", e.id] }); };

  const updatePrefs = async (matching: boolean, recs: boolean) => {
    setSaving(true);
    try {
      await rpc("update_my_registration", { p_event: e.id, p_matching_consent: matching, p_recommendations_opt_in: recs });
      await hub.refetch();
      toast.success("Preferences saved");
    } catch (err) { toast.error(friendlyError(err)); } finally { setSaving(false); }
  };
  const withdraw = async () => {
    setSaving(true);
    try {
      await rpc("withdraw_from_event", { p_event: e.id });
      qc.invalidateQueries();
      toast.success("You've left the event");
    } catch (err) { toast.error(friendlyError(err)); } finally { setSaving(false); setWithdrawOpen(false); }
  };

  const nextTarget = !h.primary_revealed ? e.primary_reveal_at : !h.recommendations_revealed ? e.post_event_reveal_at : null;

  return (
    <div className="mx-auto max-w-2xl md:pt-6">
      <section className="relative overflow-hidden rounded-b-3xl bg-navy-900 px-6 pb-8 pt-7 text-center text-cream-50 md:rounded-3xl">
        <div aria-hidden className="absolute inset-0 [background:radial-gradient(70%_70%_at_50%_0%,rgba(212,168,75,.35),transparent_65%)]" />
        <div className="relative">
          <EventStatusBadge status={e.status} paused={e.is_paused} />
          <h1 className="mt-3 text-2xl font-semibold">{e.name}</h1>
          {e.is_paused ? (
            <p className="mt-6 text-navy-100">The organiser has paused this event. Reveals are on hold until it resumes.</p>
          ) : !h.primary_revealed ? (
            <>
              <p className="mt-5 text-sm font-semibold uppercase tracking-widest text-gold-300">Your match is revealed in</p>
              <div className="mt-3"><Countdown target={e.primary_reveal_at} serverNow={h.server_now} onElapsed={refresh} label="Time until your match is revealed" /></div>
              <p className="mt-4 text-sm text-navy-200">{formatInTz(e.primary_reveal_at, e.timezone)} · {tz} ({e.timezone})</p>
            </>
          ) : (
            <div className="mt-6 space-y-3">
              <Button asChild variant="gold" size="lg"><Link to={`/e/${slug}/match`}><Sparkles className="h-5 w-5" />See your match</Link></Button>
              {nextTarget && (
                <div className="pt-4">
                  <p className="text-sm font-semibold uppercase tracking-widest text-gold-300">Five more people in</p>
                  <div className="mt-3"><Countdown target={nextTarget} serverNow={h.server_now} onElapsed={refresh} label="Time until recommendations" /></div>
                </div>
              )}
              {h.recommendations_revealed && <Button asChild variant="outline" className="border-white/30 bg-transparent text-cream-50 hover:bg-white/10"><Link to={`/e/${slug}/discover`}>Discover five more <ArrowRight className="h-4 w-4" /></Link></Button>}
            </div>
          )}
        </div>
      </section>

      <div className="page space-y-4 pt-6">
        <Card className="p-5">
          <h2 className="text-lg font-semibold">Your status</h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden />
              {h.registration.status === "checked_in" ? "Checked in" : "Registered"}{h.registration.is_late ? " · late arrival" : ""}</li>
            {h.ineligible_reasons.length === 0 ? (
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden />Ready for matching</li>
            ) : h.ineligible_reasons.map((r) => (
              <li key={r} className="flex items-center gap-2 text-gold-600"><AlertTriangle className="h-4 w-4" aria-hidden />{REASONS[r] ?? r}</li>
            ))}
            {h.registration.is_late && h.primary_revealed && (
              <li className="flex items-center gap-2 text-navy-600"><Hourglass className="h-4 w-4" aria-hidden />We'll match late arrivals together every few minutes.</li>
            )}
          </ul>
          {!h.profile_complete && <Button asChild className="mt-4"><Link to={`/profile?next=${encodeURIComponent(`/e/${slug}/hub`)}`}>Finish profile</Link></Button>}
        </Card>

        <Card className="divide-y divide-navy-100 px-5">
          <Switch checked={h.registration.matching_consent} onChange={(v) => updatePrefs(v, h.registration.recommendations_opt_in)}
            label="Primary matching" description="Turning this off after the reveal ends your current match." />
          <Switch checked={h.registration.recommendations_opt_in} onChange={(v) => updatePrefs(h.registration.matching_consent, v)}
            label="Post-event recommendations" description="Appear in, and receive, up to five recommendations." />
          {saving && <p className="py-2 text-xs text-navy-400">Saving…</p>}
        </Card>

        <Card className="p-5 text-sm">
          <h2 className="text-lg font-semibold">Schedule <span className="text-sm font-normal text-navy-400">({e.timezone})</span></h2>
          <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-2">
            <dt className="text-navy-500">Event</dt><dd className="text-right">{formatInTz(e.starts_at, e.timezone)} – {formatInTz(e.ends_at, e.timezone, { weekday: undefined, day: undefined, month: undefined })}</dd>
            <dt className="text-navy-500">Match reveal</dt><dd className="text-right">{formatInTz(e.primary_reveal_at, e.timezone)}</dd>
            <dt className="text-navy-500">Recommendations</dt><dd className="text-right">{formatInTz(e.post_event_reveal_at, e.timezone)}</dd>
          </dl>
          <p className="mt-3 text-xs text-navy-400">Times are set by the organiser and enforced by our servers; the countdown is a guide.</p>
        </Card>

        <Button variant="ghost" className="w-full text-red-700" onClick={() => setWithdrawOpen(true)}>Leave this event</Button>
        <ConfirmDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} title="Leave this event?" danger loading={saving}
          description="You'll be removed from matching and recommendations. If you already have a match, they'll simply be told you can't make it."
          confirmLabel="Leave event" onConfirm={withdraw} />
      </div>
    </div>
  );
}
