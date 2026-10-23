import * as React from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Gift, HeartHandshake, Lightbulb, MessageCircle, Sparkles, Star } from "lucide-react";
import { useEventBySlug } from "@/hooks/useEvent";
import { invoke, rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { formatInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Countdown } from "@/components/Countdown";
import { ProfileCard, type CardProfile } from "@/components/ProfileCard";
import { SafetyActions } from "@/components/SafetyActions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Card, EmptyState, Spinner } from "@/components/ui/misc";

interface MatchState {
  state: "not_registered" | "withdrawn" | "waiting" | "matching" | "matched" | "unmatched" | "match_unavailable" | "ineligible";
  server_now: string; reveal_at: string | null; paused?: boolean; awaiting_rematch?: boolean; reasons?: string[] | any;
  assignment_id?: string; score?: number; conversation_starter?: string; match?: CardProfile;
  my_followup?: "long_term" | "mentor" | "mentee" | "thanks" | null; followup_outcome?: "mutual_connect" | "mutual_mentorship" | null;
  feedback_submitted?: boolean;
}

export default function MatchReveal() {
  const { slug } = useParams();
  const ev = useEventBySlug(slug);
  const eventId = ev.data?.event.id;
  const q = useQuery({
    queryKey: ["match", eventId],
    enabled: !!eventId,
    queryFn: () => rpc<MatchState>("get_my_primary_match", { p_event: eventId }),
    refetchInterval: (query) => (["waiting", "matching"].includes(query.state.data?.state ?? "") ? 30_000 : false),
  });
  const storageKey = q.data?.assignment_id ? `mw-revealed-${q.data.assignment_id}` : null;
  const [revealed, setRevealed] = React.useState(false);
  React.useEffect(() => { if (storageKey && sessionStorage.getItem(storageKey)) setRevealed(true); }, [storageKey]);

  if (ev.isLoading || q.isLoading) return <Spinner />;
  if (!ev.data) return <Navigate to="/events" replace />;
  if (q.error) return <div className="page"><EmptyState title="Couldn't load your match">{friendlyError(q.error)}</EmptyState></div>;
  const m = q.data!; const e = ev.data.event;

  if (m.state === "not_registered" || m.state === "withdrawn") return <Navigate to={`/e/${slug}`} replace />;

  if (m.state === "waiting" || m.state === "matching") {
    return (
      <div className="page">
        <div className="rounded-3xl bg-navy-900 p-8 text-center text-cream-50">
          <Sparkles className="mx-auto h-8 w-8 text-gold-300" aria-hidden />
          <h1 className="mt-3 text-2xl font-semibold">{m.paused ? "Reveal on hold" : m.state === "matching" ? "Finding your person…" : "Not quite yet"}</h1>
          <p className="mt-2 text-navy-100">{m.paused ? "The organiser has paused the event." : m.state === "matching" ? "We're finalising matches. This page will update automatically." : "Your match will appear here at the reveal."}</p>
          {m.state === "waiting" && !m.paused && <div className="mt-6"><Countdown target={m.reveal_at} serverNow={m.server_now} onElapsed={() => q.refetch()} label="Time until reveal" /></div>}
        </div>
      </div>
    );
  }

  if (m.state !== "matched") {
    const copy = {
      unmatched: { t: "No match this round", d: "There weren't enough compatible attendees to give you a match we'd stand behind. We'd rather not invent one." },
      match_unavailable: { t: "Your match can't make it", d: "Something came up for the person we picked for you." },
      ineligible: { t: "You're not in matching", d: "Finish your profile and turn on matching in the event page to be included." },
    }[m.state];
    return (
      <div className="page">
        <EmptyState icon={<HeartHandshake className="h-6 w-6" />} title={copy.t}
          action={<div className="flex flex-col gap-2 sm:flex-row"><Button asChild variant="outline"><Link to={`/e/${slug}/hub`}>Back to event</Link></Button>
            {m.state === "ineligible" && <Button asChild><Link to={`/profile?next=/e/${slug}/hub`}>Finish profile</Link></Button>}</div>}>
          <p>{copy.d}</p>
          {m.awaiting_rematch && <p className="mt-2 font-semibold text-navy-700">We'll try to introduce you to someone new — you'll get a notification.</p>}
          <p className="mt-2">Your five post-event recommendations arrive {formatInTz(e.post_event_reveal_at, e.timezone)}.</p>
        </EmptyState>
      </div>
    );
  }

  const p = m.match!;
  const reasons: string[] = Array.isArray(m.reasons) ? m.reasons : [];
  const openResume = async () => {
    try {
      const { url } = await invoke<{ url: string }>("resume-url", { owner_id: p.id });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) { toast.error(friendlyError(err)); }
  };

  if (!revealed) {
    return (
      <div className="page flex flex-col items-center pt-10 text-center">
        <p className="eyebrow">{e.name}</p>
        <h1 className="mt-2 text-3xl font-semibold">Your match is here</h1>
        <button onClick={() => { setRevealed(true); storageKey && sessionStorage.setItem(storageKey, "1"); }}
          className="group mt-8 flex h-72 w-60 flex-col items-center justify-center rounded-3xl bg-navy-900 text-cream-50 shadow-glow transition hover:-translate-y-1 focus-visible:ring-4"
          aria-label="Reveal your match">
          <Gift className="h-12 w-12 text-gold-300 transition group-hover:scale-110" aria-hidden />
          <span className="mt-4 font-display text-xl">Tap to reveal</span>
        </button>
      </div>
    );
  }

  return (
    <div className="page space-y-5">
      <div className="animate-fade-in text-center">
        <p className="eyebrow">Your match at {e.name}</p>
        <h1 className="mt-1 text-2xl font-semibold">Meet {p.first_name || p.full_name}</h1>
      </div>
      <div className="animate-reveal-up">
        <ProfileCard p={p} onResume={openResume}
          highlight={reasons.length > 0 && (
            <div className="rounded-2xl border border-navy-100 p-4">
              <h2 className="eyebrow mb-2 flex items-center gap-1.5"><Lightbulb className="h-3.5 w-3.5" aria-hidden />Why we matched you</h2>
              <ul className="space-y-1.5 text-[15px] text-navy-800">{reasons.map((r) => <li key={r} className="flex gap-2"><span className="text-gold-500" aria-hidden>✦</span>{r}</li>)}</ul>
            </div>
          )} />
      </div>
      {m.conversation_starter && (
        <Card className="flex gap-3 p-5 animate-reveal-up [animation-delay:150ms]">
          <MessageCircle className="h-5 w-5 shrink-0 text-gold-500" aria-hidden />
          <div><h2 className="font-semibold">Conversation starter</h2><p className="mt-1 text-navy-700">{m.conversation_starter}</p></div>
        </Card>
      )}
      <FollowUp m={m} name={p.first_name || "them"} onDone={() => q.refetch()} />
      {!m.feedback_submitted && <FeedbackForm assignmentId={m.assignment_id!} onDone={() => q.refetch()} />}
      <div className="flex justify-center"><SafetyActions userId={p.id} name={p.first_name || "this person"} eventId={e.id} onBlocked={() => q.refetch()} /></div>
    </div>
  );
}

function FollowUp({ m, name, onDone }: { m: MatchState; name: string; onDone: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  if (m.followup_outcome) {
    return (
      <Card className="border-gold-300 bg-gold-100/40 p-5 text-center">
        <Sparkles className="mx-auto h-6 w-6 text-gold-500" aria-hidden />
        <h2 className="mt-2 text-lg font-semibold">It's mutual!</h2>
        <p className="mt-1 text-navy-600">{m.followup_outcome === "mutual_mentorship" ? `You and ${name} both want to explore mentorship.` : `You and ${name} both want to stay in touch.`}</p>
        <Button asChild className="mt-4"><Link to="/connections">Open connections</Link></Button>
      </Card>
    );
  }
  const choose = async (choice: string) => {
    setBusy(choice);
    try {
      const r = await rpc<{ outcome: string | null }>("submit_match_followup", { p_assignment: m.assignment_id, p_choice: choice });
      toast.success(r.outcome ? "It's mutual!" : "Saved. We'll only tell you if it's mutual.");
      onDone();
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(null); }
  };
  const opts = [
    { v: "long_term", t: "Stay in touch", d: "Request a long-term connection" },
    { v: "mentee", t: "I'd value their mentorship", d: "Explore them mentoring you" },
    { v: "mentor", t: "I'd like to mentor them", d: "Offer to mentor" },
    { v: "thanks", t: "Thanks, and move on", d: "A good chat — no follow-up" },
  ];
  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold">After you've met</h2>
      <p className="mt-1 text-sm text-navy-500">Your choice is private. We only share contact details if you both want to stay in touch.</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {opts.map((o) => (
          <button key={o.v} onClick={() => choose(o.v)} disabled={!!busy} aria-pressed={m.my_followup === o.v}
            className={cn("rounded-2xl border p-4 text-left transition", m.my_followup === o.v ? "border-navy-900 bg-navy-900 text-cream-50" : "border-navy-200 bg-white hover:border-navy-400")}>
            <div className="font-semibold">{o.t}</div>
            <div className={cn("text-sm", m.my_followup === o.v ? "text-navy-100" : "text-navy-500")}>{busy === o.v ? "Saving…" : o.d}</div>
          </button>
        ))}
      </div>
      {m.my_followup && m.my_followup !== "thanks" && <p className="mt-3 text-sm text-navy-500">We'll let you know if {name} feels the same.</p>}
    </Card>
  );
}

function FeedbackForm({ assignmentId, onDone }: { assignmentId: string; onDone: () => void }) {
  const [rating, setRating] = React.useState(0);
  const [met, setMet] = React.useState<boolean | null>(null);
  const [eventRating, setEventRating] = React.useState(0);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await rpc("submit_match_feedback", { p_assignment: assignmentId, p_rating: rating, p_met_in_person: !!met, p_event_rating: eventRating || null, p_comment: comment || null });
      toast.success("Thanks for the feedback!");
      onDone();
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5">
      <h2 className="text-lg font-semibold">How was it?</h2>
      <p className="mt-1 text-sm text-navy-500">Anonymous to your match. Helps organisers improve matching.</p>
      <div className="mt-4 space-y-4">
        <div className="flex gap-2">
          <Button variant={met === true ? "primary" : "outline"} size="sm" onClick={() => setMet(true)}>We met</Button>
          <Button variant={met === false ? "primary" : "outline"} size="sm" onClick={() => setMet(false)}>We didn't meet</Button>
        </div>
        <Stars label="Match quality" value={rating} onChange={setRating} />
        <Stars label="The event overall" value={eventRating} onChange={setEventRating} />
        <Textarea placeholder="Anything to add? (optional)" maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
        <Button onClick={submit} loading={busy} disabled={!rating || met === null}>Send feedback</Button>
      </div>
    </Card>
  );
}

function Stars({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div role="radiogroup" aria-label={label}>
      <div className="mb-1 text-sm font-semibold">{label}</div>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? "s" : ""}`} onClick={() => onChange(n)} className="rounded p-1">
            <Star className={cn("h-7 w-7", n <= value ? "fill-gold-400 text-gold-400" : "text-navy-200")} />
          </button>
        ))}
      </div>
    </div>
  );
}
