import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Eye, Play, RefreshCw, UserPlus, Wand2 } from "lucide-react";
import { invoke, rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { WEIGHT_LABELS } from "@/lib/options";
import { relativeTime } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input, Switch } from "@/components/ui/form";
import { Badge, Card, ConfirmDialog, Dialog, DialogContent, ErrorNote, Spinner } from "@/components/ui/misc";
import type { Detail } from "./OrganiserEvent";

const RULE_LABELS: Record<string, [string, string]> = {
  exclude_same_organisation: ["Don't match colleagues", "People from the same organisation are never paired."],
  auto_match_late_arrivals: ["Auto-match late arrivals", "Every few minutes, pair late arrivals and anyone whose match dropped out."],
  complementary_only: ["Complementary pairs only", "Only pair people whose goals complement each other (e.g. seeker + hirer)."],
  recruiters_only_with_seekers: ["Recruiters meet job seekers only", "People who are hiring are only paired with people looking for a role."],
};

export function MatchingTab({ d, refetch }: { d: Detail; refetch: () => void }) {
  const e = d.event;
  const [weights, setWeights] = React.useState<Record<string, number>>(e.matching_weights);
  const [rules, setRules] = React.useState<Record<string, any>>(e.role_rules);
  const [saving, setSaving] = React.useState(false);
  const [preview, setPreview] = React.useState<any | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [launch, setLaunch] = React.useState<null | { mode: "primary" | "supplemental"; rerun: boolean; key: string }>(null);
  const [running, setRunning] = React.useState(false);
  const [recsConfirm, setRecsConfirm] = React.useState(false);
  const [round, setRound] = React.useState<string | null>(null);

  const total = Object.values(weights).reduce((s, v) => s + Number(v || 0), 0);
  const hasPrimary = d.rounds.some((r) => r.mode === "primary" && r.status === "completed");
  const running_ = d.rounds.find((r) => r.status === "running");
  const canPrimary = ["registration_closed", "matching_in_progress", "primary_ready"].includes(e.status)
    || (e.status === "registration_open" && !!e.registration_deadline && new Date(e.registration_deadline) <= new Date());

  const saveConfig = async () => {
    setSaving(true);
    try { await rpc("update_matching_config", { p_event: e.id, p_weights: weights, p_rules: { ...rules, min_score: Number(rules.min_score) } }); toast.success("Matching settings saved"); refetch(); }
    catch (err) { toast.error(friendlyError(err)); } finally { setSaving(false); }
  };
  const doPreview = async (mode: "primary" | "supplemental") => {
    setPreviewing(true);
    try { setPreview({ mode, ...(await invoke("run-matching", { event_id: e.id, action: "preview", mode })) }); }
    catch (err) { toast.error(friendlyError(err)); } finally { setPreviewing(false); }
  };
  const doLaunch = async () => {
    if (!launch) return;
    setRunning(true);
    try {
      const r = await invoke<any>("run-matching", { event_id: e.id, action: "launch", mode: launch.mode, confirm_rerun: launch.rerun, idempotency_key: launch.key });
      if (r.status === "skipped") toast.message("Not enough unmatched attendees for a new round.");
      else if (r.status === "already_running") toast.message("A matching job is already running.");
      else toast.success(`Matching complete: ${r.matched_pairs ?? "—"} pairs`);
      setLaunch(null); refetch();
    } catch (err) { toast.error(friendlyError(err)); refetch(); } finally { setRunning(false); }
  };
  const doRecs = async () => {
    setRunning(true);
    try { const r = await invoke<any>("generate-recommendations", { event_id: e.id, confirm: d.recommendations_revealed }); toast.success(`${r.count} recommendations generated`); setRecsConfirm(false); refetch(); }
    catch (err) { toast.error(friendlyError(err)); } finally { setRunning(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Run matching</h2>
          {running_ && <Badge tone="gold"><RefreshCw className="h-3 w-3 animate-spin" />Job running</Badge>}
        </div>
        <p className="mt-1 text-sm text-navy-500">
          Matching runs automatically once registration closes, using a global maximum-weight algorithm (no first-come-first-served).
          Results stay hidden until the reveal. Retrying is always safe.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" loading={previewing} onClick={() => doPreview(hasPrimary && d.primary_revealed ? "supplemental" : "primary")}><Eye className="h-4 w-4" />Preview</Button>
          {!d.primary_revealed && (
            <Button disabled={!canPrimary || e.is_paused} onClick={() => setLaunch({ mode: "primary", rerun: hasPrimary, key: crypto.randomUUID() })}>
              <Play className="h-4 w-4" />{hasPrimary ? "Re-run matching" : "Launch matching"}
            </Button>
          )}
          {hasPrimary && (
            <Button variant="outline" disabled={e.is_paused} onClick={() => setLaunch({ mode: "supplemental", rerun: false, key: crypto.randomUUID() })}><UserPlus className="h-4 w-4" />Match late arrivals now</Button>
          )}
          <Button variant="outline" onClick={() => setRecsConfirm(true)}><Wand2 className="h-4 w-4" />{e.recommendations_generated_at ? "Regenerate" : "Generate"} recommendations</Button>
        </div>
        {!canPrimary && !hasPrimary && <p className="mt-3 text-sm text-navy-400">Available after the registration deadline.</p>}
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold">Rounds</h2>
        {d.rounds.length === 0 ? <p className="mt-1 text-sm text-navy-400">No matching rounds yet.</p> : (
          <ul className="mt-3 divide-y divide-navy-100">
            {d.rounds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <span className="font-semibold">Round {r.round_number}</span> · {r.mode === "primary" ? "Main" : "Late arrivals"} ·{" "}
                  <Badge tone={r.status === "completed" ? "green" : r.status === "failed" ? "red" : r.status === "running" ? "gold" : "neutral"}>{r.status}</Badge>
                  <p className="text-navy-500">{r.eligible_count} eligible · {r.matched_pairs} pairs · {r.unmatched_count} unmatched · {relativeTime(r.started_at)}</p>
                  {r.error && <p className="text-red-700">Error: {r.error}</p>}
                </div>
                {r.status !== "running" && r.status !== "failed" && <Button size="sm" variant="ghost" onClick={() => setRound(r.id)}>Review</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold">Weights</h2>
        <p className="mt-1 text-sm text-navy-500">Starting hypotheses, not validated measurements — tune them using feedback. Normalised to {total || 0} total.</p>
        <div className="mt-4 space-y-4">
          {Object.keys(WEIGHT_LABELS).map((k) => (
            <div key={k}>
              <div className="flex justify-between text-sm"><label htmlFor={`w-${k}`} className="font-semibold">{WEIGHT_LABELS[k]}</label>
                <span className="tabular-nums text-navy-500">{total ? Math.round((Number(weights[k] ?? 0) / total) * 100) : 0}%</span></div>
              <input id={`w-${k}`} type="range" min={0} max={100} value={weights[k] ?? 0} onChange={(ev) => setWeights({ ...weights, [k]: Number(ev.target.value) })} className="mt-1 w-full accent-navy-900" />
            </div>
          ))}
        </div>
        <h3 className="mt-6 font-semibold">Rules</h3>
        <div className="divide-y divide-navy-100">
          {Object.entries(RULE_LABELS).map(([k, [l, desc]]) => <Switch key={k} checked={!!rules[k]} onChange={(v) => setRules({ ...rules, [k]: v })} label={l} description={desc} />)}
          <div className="flex items-center justify-between gap-4 py-3">
            <div><label htmlFor="minscore" className="font-semibold">Minimum match score</label><p className="text-sm text-navy-500">Below this, people stay unmatched rather than get a weak match.</p></div>
            <Input id="minscore" type="number" min={0} max={90} className="w-24" value={rules.min_score ?? 15} onChange={(ev) => setRules({ ...rules, min_score: ev.target.value })} />
          </div>
        </div>
        <Button className="mt-4" loading={saving} onClick={saveConfig} disabled={total <= 0}>Save matching settings</Button>
        {hasPrimary && <p className="mt-2 text-xs text-navy-400">Saved settings apply to the next round you run.</p>}
      </Card>

      {preview && (
        <Dialog open onOpenChange={(o) => !o && setPreview(null)}>
          <DialogContent title={preview.mode === "supplemental" ? "Late-arrival round preview" : "Matching preview"}
            description={preview.mode === "supplemental" ? "Nothing has been saved. Shows attendees without an active match who would be paired now." : "Nothing has been saved. This is what launching now would produce."}>
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-xl bg-white p-3 ring-1 ring-navy-100"><div className="text-xl font-semibold">{preview.eligible}</div>eligible</div>
              <div className="rounded-xl bg-white p-3 ring-1 ring-navy-100"><div className="text-xl font-semibold">{preview.pairs.length}</div>pairs</div>
              <div className="rounded-xl bg-white p-3 ring-1 ring-navy-100"><div className="text-xl font-semibold">{preview.average_score ?? "—"}</div>avg score</div>
            </div>
            {preview.eligible < 2 && <div className="mt-3"><ErrorNote>Not enough eligible attendees to match yet.</ErrorNote></div>}
            <ul className="mt-4 max-h-72 space-y-2 overflow-y-auto text-sm">
              {preview.pairs.map((p: any, i: number) => <li key={i} className="rounded-xl bg-white p-3 ring-1 ring-navy-100"><strong>{p.a}</strong> & <strong>{p.b}</strong> · {p.score}<p className="text-navy-500">{p.reasons[0]}</p></li>)}
            </ul>
            {preview.unmatched.length > 0 && <p className="mt-3 text-sm text-navy-500">Unmatched: {preview.unmatched.join(", ")}</p>}
          </DialogContent>
        </Dialog>
      )}
      {launch && (
        <ConfirmDialog open onOpenChange={(o) => !o && setLaunch(null)} loading={running} onConfirm={doLaunch}
          title={launch.mode === "supplemental" ? "Match late arrivals now?" : launch.rerun ? "Re-run matching?" : "Launch matching?"}
          description={launch.mode === "supplemental" ? "Pairs attendees without an active match. Existing matches are untouched."
            : launch.rerun ? "This replaces all current (unrevealed) assignments with a fresh run using the latest settings." : "Assignments are saved now and revealed at the scheduled time."}
          confirmLabel={launch.rerun ? "Re-run" : "Run"} danger={launch.rerun} />
      )}
      <ConfirmDialog open={recsConfirm} onOpenChange={setRecsConfirm} loading={running} onConfirm={doRecs} danger={d.recommendations_revealed}
        title={d.recommendations_revealed ? "Regenerate visible recommendations?" : "Generate recommendations?"}
        description={d.recommendations_revealed ? "Attendees can already see their recommendations; this will replace them." : "They stay hidden until the post-event reveal time. They're also generated automatically shortly before the reveal."} />
      {round && <RoundReview roundId={round} onClose={() => setRound(null)} onChanged={refetch} />}
    </div>
  );
}

function RoundReview({ roundId, onClose, onChanged }: { roundId: string; onClose: () => void; onChanged: () => void }) {
  const q = useQuery({ queryKey: ["round", roundId], queryFn: () => rpc<any>("organiser_round_assignments", { p_round: roundId }) });
  const [cancel, setCancel] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Assignments" description="Organisers can review pairs and handle exceptional cases. Attendees never see scores.">
        {q.isLoading ? <Spinner /> : (
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto text-sm">
            {q.data.assignments.map((a: any) => (
              <li key={a.id} className="rounded-xl bg-white p-3 ring-1 ring-navy-100">
                <div className="flex justify-between gap-2"><span><strong>{a.user_a.full_name ?? "Deleted user"}</strong> & <strong>{a.user_b.full_name ?? "Deleted user"}</strong></span><span className="tabular-nums">{a.score}</span></div>
                <p className="text-navy-500">{(a.reasons ?? [])[0]}</p>
                <div className="mt-1 flex items-center justify-between">
                  <Badge tone={a.status === "active" ? "green" : "neutral"}>{a.status}{a.cancel_reason ? ` · ${a.cancel_reason}` : ""}</Badge>
                  {a.status === "active" && <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setCancel(a.id)}>Cancel pair</Button>}
                </div>
              </li>
            ))}
            {q.data.unmatched.length > 0 && <li className="pt-2 text-navy-500">Unmatched: {q.data.unmatched.map((u: any) => u.full_name).join(", ")}</li>}
          </ul>
        )}
        <ConfirmDialog open={!!cancel} onOpenChange={(o) => !o && setCancel(null)} danger loading={busy} title="Cancel this pair?"
          description="Both people become eligible for a late-arrival round. If already revealed, they're told only that their match can't make it."
          onConfirm={async () => {
            setBusy(true);
            try { await rpc("organiser_cancel_assignment", { p_assignment: cancel, p_reason: "organiser" }); q.refetch(); onChanged(); }
            catch (err) { toast.error(friendlyError(err)); } finally { setBusy(false); setCancel(null); }
          }} />
      </DialogContent>
    </Dialog>
  );
}
