// Matching & recommendation engine plus job orchestration. Pure TS; the only
// side effects go through the injected `rpc` function, so the exact same code
// runs in edge functions (supabase-js) and in integration tests (pg).
import { maxWeightMatching } from "./blossom.ts";
import {
  type Features, type PairScore, type Rules, type Weights,
  normaliseRules, normaliseWeights, pairAllowed, scorePair,
} from "./scoring.ts";

export const ALGORITHM = "blossom-mwm-maxcard/v1";
export const MAX_RECOMMENDATIONS = 5;

export interface PoolSnapshot {
  weights: Partial<Weights>;
  rules: Partial<Rules>;
  members: Features[];
  blocked_pairs: [string, string][];
  excluded_pairs: [string, string][];
  primary_pairs?: [string, string][];
  connected_pairs?: [string, string][];
}

export interface PairOut {
  a: string; b: string; score: number;
  breakdown: PairScore["breakdown"];
  reasons_a: string[]; reasons_b: string[];
  starter_a: string; starter_b: string;
}

export interface RecOut { user_id: string; recommended_user_id: string; rank: number; score: number; reasons: string[] }

const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

function pairSet(...lists: Array<[string, string][] | undefined>) {
  const s = new Set<string>();
  for (const l of lists) for (const [x, y] of l ?? []) s.add(key(x, y));
  return s;
}

/**
 * Global maximum-weight matching over all eligible pairs. Members are sorted
 * by id so the result never depends on registration/submission order, and the
 * same snapshot always yields the same assignments (safe retries).
 * maxCardinality=true: match as many people as possible among pairs that pass
 * the quality threshold, then maximise total score.
 */
export function computePrimaryMatching(snap: PoolSnapshot): { pairs: PairOut[]; unmatched: string[]; candidatePairs: number } {
  const weights = normaliseWeights(snap.weights);
  const rules = normaliseRules(snap.rules);
  const members = [...snap.members].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const banned = pairSet(snap.blocked_pairs, snap.excluded_pairs);

  const edges: Array<[number, number, number]> = [];
  const scores = new Map<string, PairScore>();
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j];
      if (banned.has(key(a.id, b.id))) continue;
      const s = scorePair(a, b, weights, "match");
      if (!pairAllowed(a, b, rules, s)) continue;
      scores.set(`${i}|${j}`, s);
      // Weight must be positive for the matcher to prefer using the edge.
      edges.push([i, j, Math.max(0.01, s.score)]);
    }
  }

  const mate = edges.length ? maxWeightMatching(edges, true) : [];
  const pairs: PairOut[] = [];
  const matched = new Set<number>();
  for (let i = 0; i < mate.length; i++) {
    const j = mate[i];
    if (j < 0 || j < i) continue;
    const s = scores.get(`${i}|${j}`)!;
    matched.add(i); matched.add(j);
    pairs.push({
      a: members[i].id, b: members[j].id, score: s.score, breakdown: s.breakdown,
      reasons_a: s.reasonsA, reasons_b: s.reasonsB, starter_a: s.starterA, starter_b: s.starterB,
    });
  }
  const unmatched = members.filter((_, i) => !matched.has(i)).map((m) => m.id);
  return { pairs, unmatched, candidatePairs: edges.length };
}

/**
 * Up to five recommendations per person, ranked by the same compatibility
 * score. Excludes self, the primary match, blocked users, existing
 * connections and same-organisation colleagues (if the rule is on). Returns
 * fewer than five when fewer eligible candidates exist.
 */
export function computeRecommendations(snap: PoolSnapshot): RecOut[] {
  const weights = normaliseWeights(snap.weights);
  const rules = normaliseRules(snap.rules);
  const recRules: Rules = { ...rules, complementary_only: false, recruiters_only_with_seekers: false, min_score: Math.max(5, rules.min_score / 2) };
  const members = [...snap.members].sort((x, y) => (x.id < y.id ? -1 : 1));
  const banned = pairSet(snap.blocked_pairs, snap.primary_pairs, snap.connected_pairs);
  const out: RecOut[] = [];
  const cache = new Map<string, PairScore>();

  for (const u of members) {
    const cands: Array<{ v: Features; s: PairScore; reasons: string[] }> = [];
    for (const v of members) {
      if (v.id === u.id || banned.has(key(u.id, v.id))) continue;
      const k = key(u.id, v.id);
      let s = cache.get(k);
      const first = u.id < v.id ? u : v;
      if (!s) { s = scorePair(first, first === u ? v : u, weights, "recommendation"); cache.set(k, s); }
      if (!pairAllowed(u, v, recRules, s)) continue;
      cands.push({ v, s, reasons: first === u ? s.reasonsA : s.reasonsB });
    }
    cands.sort((x, y) => y.s.score - x.s.score || (x.v.id < y.v.id ? -1 : 1));
    cands.slice(0, MAX_RECOMMENDATIONS).forEach((c, idx) =>
      out.push({ user_id: u.id, recommended_user_id: c.v.id, rank: idx + 1, score: c.s.score, reasons: c.reasons }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<any>;

export interface MatchJobInput {
  eventId: string;
  mode: "primary" | "supplemental";
  actor?: string | null;
  confirmRerun?: boolean;
  idempotencyKey?: string | null;
}

export async function runMatchingJob(rpc: Rpc, input: MatchJobInput) {
  const begin = await rpc("service_begin_match_round", {
    p_event: input.eventId,
    p_mode: input.mode,
    p_actor: input.actor ?? null,
    p_confirm_rerun: !!input.confirmRerun,
    p_idempotency_key: input.idempotencyKey ?? null,
  });
  if (begin.skipped) return { status: "skipped", ...begin };
  if (begin.already_running) return { status: "already_running", round_id: begin.round_id };
  if (begin.status === "completed") return { status: "completed", round_id: begin.round_id, reused: true };

  const roundId: string = begin.round_id;
  try {
    const snap = await rpc("service_round_snapshot", { p_round: roundId });
    const result = computePrimaryMatching(snap);
    const commit = await rpc("service_commit_match_round", {
      p_round: roundId, p_pairs: result.pairs, p_algorithm: ALGORITHM,
    });
    return { status: "completed", round_id: roundId, matched_pairs: commit.matched_pairs, unmatched: commit.unmatched };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await rpc("service_fail_match_round", { p_round: roundId, p_error: message }); } catch { /* reported below */ }
    throw err;
  }
}

export async function previewMatching(rpc: Rpc, eventId: string, mode: "primary" | "supplemental") {
  const snap = await rpc("service_matching_preview", { p_event: eventId, p_mode: mode });
  const result = computePrimaryMatching(snap);
  const names = new Map<string, string>((snap.members as Features[]).map((m) => [m.id, m.first_name]));
  return {
    eligible: snap.members.length,
    candidate_pairs: result.candidatePairs,
    pairs: result.pairs.map((p) => ({ a: names.get(p.a), b: names.get(p.b), score: p.score, reasons: p.reasons_a })),
    unmatched: result.unmatched.map((id) => names.get(id)),
    average_score: result.pairs.length ? Math.round((result.pairs.reduce((s, p) => s + p.score, 0) / result.pairs.length) * 10) / 10 : null,
  };
}

export async function runRecommendationJob(rpc: Rpc, eventId: string) {
  const snap = await rpc("service_recommendation_snapshot", { p_event: eventId });
  const recs = computeRecommendations(snap);
  const res = await rpc("service_commit_recommendations", { p_event: eventId, p_recs: recs });
  return { status: "completed", count: res.count, members: snap.members.length };
}

/** One scheduler pass: lifecycle tick, then any due jobs, then tick again. */
export async function runSchedulerPass(rpc: Rpc) {
  const work = await rpc("service_scheduler_tick", {});
  const results: Array<Record<string, unknown>> = [];
  for (const id of work.match as string[]) {
    results.push(await runMatchingJob(rpc, { eventId: id, mode: "primary", idempotencyKey: null })
      .then((r) => ({ event_id: id, job: "primary", ...r }))
      .catch((e) => ({ event_id: id, job: "primary", status: "failed", error: String(e?.message ?? e) })));
  }
  for (const id of work.supplemental as string[]) {
    results.push(await runMatchingJob(rpc, { eventId: id, mode: "supplemental" })
      .then((r) => ({ event_id: id, job: "supplemental", ...r }))
      .catch((e) => ({ event_id: id, job: "supplemental", status: "failed", error: String(e?.message ?? e) })));
  }
  for (const id of work.recommendations as string[]) {
    results.push(await runRecommendationJob(rpc, id)
      .then((r) => ({ event_id: id, job: "recommendations", ...r }))
      .catch((e) => ({ event_id: id, job: "recommendations", status: "failed", error: String(e?.message ?? e) })));
  }
  if (results.length) await rpc("service_scheduler_tick", {});
  return { work, results };
}
