// Meetwise pair scoring. Pure TypeScript, no imports, so it runs in Deno edge
// functions and in Node tests. Every reason string is derived from the actual
// overlap that produced the score, and respects the subject's visibility
// settings, so explanations are always truthful and never leak hidden fields.

export type WeightKey =
  | "goal_complementarity"
  | "industry_role"
  | "experience_mentorship"
  | "professional_interests"
  | "personal_interests"
  | "location";

export type Weights = Record<WeightKey, number>;

export const DEFAULT_WEIGHTS: Weights = {
  goal_complementarity: 30,
  industry_role: 25,
  experience_mentorship: 15,
  professional_interests: 15,
  personal_interests: 10,
  location: 5,
};

export interface Rules {
  exclude_same_organisation: boolean;
  min_score: number;
  auto_match_late_arrivals?: boolean;
  complementary_only: boolean;
  recruiters_only_with_seekers: boolean;
}

export const DEFAULT_RULES: Rules = {
  exclude_same_organisation: true,
  min_score: 15,
  auto_match_late_arrivals: true,
  complementary_only: false,
  recruiters_only_with_seekers: false,
};

export interface Features {
  id: string;
  first_name: string;
  organisation: string | null;
  role_category: string | null;
  industry: string | null;
  employment_status: string | null;
  career_stage: string | null;
  work_environment: string | null;
  career_goals: string[];
  target_roles: string[];
  target_industries: string[];
  skills: string[];
  professional_interests: string[];
  mentorship_preference: string | null;
  hobbies: string[];
  city: string | null;
  country: string | null;
  match_visible_fields: string[];
  recommendation_visible_fields: string[];
}

export type Context = "match" | "recommendation";

export interface PairScore {
  score: number;
  breakdown: Record<WeightKey, number>;
  complementary: boolean;
  /** Reasons shown to A about B, and to B about A. */
  reasonsA: string[];
  reasonsB: string[];
  starterA: string;
  starterB: string;
}

const STAGES = ["student", "early_career", "mid_career", "senior", "executive"];

const INDUSTRY_LABELS: Record<string, string> = {
  technology: "technology", finance: "finance", investment: "investing", healthcare: "healthcare",
  biotech: "biotech", education: "education", consulting: "consulting", media: "media",
  retail: "retail", manufacturing: "manufacturing", energy: "energy", climate: "climate",
  government: "government", nonprofit: "the nonprofit sector", legal: "legal", real_estate: "real estate",
  hospitality: "hospitality", transport: "transport", telecoms: "telecoms", other: "their field",
};

export function industryLabel(i: string | null | undefined): string {
  return (i && INDUSTRY_LABELS[i]) || "their field";
}

/**
 * Complementary goal pairs: [seeker goal, offerer goal, strength, reason for
 * the seeker about the offerer, reason for the offerer about the seeker].
 * `{n}` = the other person's first name, `{i}` = their industry.
 */
const COMPLEMENTS: Array<[string, string, number, string, string]> = [
  ["find_job", "hire_talent", 1, "{n} is hiring — and you're looking for your next role.", "{n} is exploring new roles — and you're hiring."],
  ["find_mentor", "mentor_others", 1, "{n} wants to mentor others, and you're looking for a mentor.", "{n} is looking for a mentor — you said you'd like to mentor."],
  ["start_company", "advise_founders", 1, "{n} has founder experience to share as you build your company.", "{n} is starting a company and could use your founder experience."],
  ["raise_funding", "invest", 1, "{n} is looking to invest, and you're raising.", "{n} is raising — and you're looking to invest."],
  ["change_careers", "share_career_advice", 0.9, "{n} enjoys sharing career advice, and you're considering a change.", "{n} is considering a career change — and you like sharing career advice."],
  ["find_cofounder", "start_company", 0.7, "{n} is starting a company, and you're looking for a co-founder.", "{n} is looking for a co-founder while you're starting a company."],
];

const SYMMETRIC_GOALS: Array<[string, number, string]> = [
  ["find_cofounder", 0.9, "You're both looking for a co-founder."],
  ["collaborate_projects", 0.5, "You're both keen to collaborate on projects."],
  ["start_company", 0.4, "You're both building something new."],
  ["learn_industry", 0.3, "You're both here to learn about new industries."],
  ["expand_network", 0.2, "You're both here to grow your network."],
  ["find_clients", 0.2, "You're both looking for new clients."],
];

function has(list: string[] | null | undefined, v: string | null | undefined): boolean {
  return !!v && !!list && list.includes(v);
}

function norm(tags: string[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tags ?? []) {
    const k = t.trim().toLowerCase();
    if (k && !m.has(k)) m.set(k, t.trim());
  }
  return m;
}

function overlap(a: string[], b: string[]): string[] {
  const nb = norm(b);
  const out: string[] = [];
  for (const [k, v] of norm(a)) if (nb.has(k)) out.push(v);
  return out.sort((x, y) => x.localeCompare(y));
}

function seeksMentor(f: Features) {
  return f.mentorship_preference === "seeking" || f.mentorship_preference === "both" || has(f.career_goals, "find_mentor");
}
function offersMentoring(f: Features) {
  return f.mentorship_preference === "offering" || f.mentorship_preference === "both" || has(f.career_goals, "mentor_others");
}

function fill(t: string, other: Features) {
  return t.replaceAll("{n}", other.first_name || "Your match").replaceAll("{i}", industryLabel(other.industry));
}

function list(items: string[]) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function visible(f: Features, field: string, ctx: Context) {
  const v = ctx === "match" ? f.match_visible_fields : f.recommendation_visible_fields;
  return (v ?? []).includes(field);
}

interface Reason { weight: number; text: string }

/** Score in [0, 100] plus per-viewer reasons. Symmetric in (a, b). */
export function scorePair(a: Features, b: Features, weights: Weights, ctx: Context = "match"): PairScore {
  const rA: Reason[] = []; // shown to A, about B
  const rB: Reason[] = []; // shown to B, about A
  const startA: Reason[] = [];
  const startB: Reason[] = [];

  // 1. Career goal complementarity -----------------------------------------
  let best = 0; let hits = 0;
  for (const [seek, offer, strength, seekerText, offererText] of COMPLEMENTS) {
    for (const [s, o, rs, ro, ss, so] of [[a, b, rA, rB, startA, startB], [b, a, rB, rA, startB, startA]] as const) {
      if (!has(s.career_goals, seek) || !has(o.career_goals, offer)) continue;
      let w = strength;
      if (seek === "find_job") {
        // A recruiter in an industry the seeker targets is more relevant.
        const targets = s.target_industries ?? [];
        w = targets.length === 0 || has(targets, o.industry) ? 1 : 0.6;
      }
      hits++; best = Math.max(best, w);
      rs.push({ weight: 30 * w, text: fill(seekerText, o) });
      ro.push({ weight: 30 * w, text: fill(offererText, s) });
      ss.push({ weight: 30 * w, text: starterFor(seek, o) });
      so.push({ weight: 30 * w, text: starterFor(offer, s) });
    }
  }
  let shared = 0;
  for (const [g, strength, text] of SYMMETRIC_GOALS) {
    if (has(a.career_goals, g) && has(b.career_goals, g)) {
      shared = Math.max(shared, strength);
      rA.push({ weight: 20 * strength, text }); rB.push({ weight: 20 * strength, text });
    }
  }
  const goal = Math.min(1, Math.max(best, shared) + 0.1 * Math.max(0, hits - 1));
  const complementary = best > 0;

  // 2. Industry & role relevance -------------------------------------------
  const directional = (s: Features, o: Features) =>
    Math.min(1, (has(s.target_industries, o.industry) ? 0.6 : 0) + (has(s.target_roles, o.role_category) ? 0.4 : 0));
  const dA = directional(a, b); const dB = directional(b, a);
  const sameIndustry = !!a.industry && a.industry === b.industry && a.industry !== "other";
  const sameRole = !!a.role_category && a.role_category === b.role_category && a.role_category !== "other";
  const industry = Math.min(1, Math.max((dA + dB) / 2 + 0.25 * Math.max(dA, dB), sameIndustry ? 0.6 : 0) + (sameRole ? 0.2 : 0));
  if (has(a.target_industries, b.industry)) rA.push({ weight: 15, text: fill("{n} works in {i}, one of your target industries.", b) });
  if (has(b.target_industries, a.industry)) rB.push({ weight: 15, text: fill("{n} works in {i}, one of your target industries.", a) });
  if (sameIndustry) {
    const t = `You both work in ${industryLabel(a.industry)}.`;
    rA.push({ weight: 12, text: t }); rB.push({ weight: 12, text: t });
    startA.push({ weight: 8, text: fill("Ask {n} what's changing fastest in {i} right now.", b) });
    startB.push({ weight: 8, text: fill("Ask {n} what's changing fastest in {i} right now.", a) });
  }

  // 3. Experience & mentorship fit -----------------------------------------
  const sa = STAGES.indexOf(a.career_stage ?? ""); const sb = STAGES.indexOf(b.career_stage ?? "");
  let exp = 0;
  if (sa >= 0 && sb >= 0) {
    if (seeksMentor(a) && offersMentoring(b) && sb > sa) {
      exp = 1;
      rA.push({ weight: 18, text: fill("{n} is further along and open to mentoring.", b) });
      rB.push({ weight: 18, text: fill("{n} is earlier in their career and looking for guidance you could offer.", a) });
    } else if (seeksMentor(b) && offersMentoring(a) && sa > sb) {
      exp = 1;
      rB.push({ weight: 18, text: fill("{n} is further along and open to mentoring.", a) });
      rA.push({ weight: 18, text: fill("{n} is earlier in their career and looking for guidance you could offer.", b) });
    } else if ((seeksMentor(a) && offersMentoring(b)) || (seeksMentor(b) && offersMentoring(a))) {
      exp = 0.5;
    } else {
      exp = 0.6 * (1 - Math.abs(sa - sb) / 4);
      if (sa === sb && sa >= 0) {
        rA.push({ weight: 4, text: "You're at a similar career stage." });
        rB.push({ weight: 4, text: "You're at a similar career stage." });
      }
    }
  }

  // 4. Shared professional interests ---------------------------------------
  const pro = overlap([...(a.skills ?? []), ...(a.professional_interests ?? [])], [...(b.skills ?? []), ...(b.professional_interests ?? [])]);
  const proScore = Math.min(1, pro.length / 3);
  if (pro.length > 0) {
    const t = `You share an interest in ${list(pro.slice(0, 3))}.`;
    rA.push({ weight: 10 + 3 * pro.length, text: t }); rB.push({ weight: 10 + 3 * pro.length, text: t });
    startA.push({ weight: 10, text: `Ask ${b.first_name || "them"} what's exciting them in ${pro[0]} lately.` });
    startB.push({ weight: 10, text: `Ask ${a.first_name || "them"} what's exciting them in ${pro[0]} lately.` });
  }

  // 5. Shared personal interests -------------------------------------------
  const hob = overlap(a.hobbies ?? [], b.hobbies ?? []);
  const hobScore = Math.min(1, hob.length / 2);
  // Only mention hobbies the other person lets this viewer see.
  if (hob.length > 0 && visible(a, "hobbies", ctx) && visible(b, "hobbies", ctx)) {
    const t = `You're both into ${list(hob.slice(0, 2))}.`;
    rA.push({ weight: 8, text: t }); rB.push({ weight: 8, text: t });
    startA.push({ weight: 12, text: `Ask ${b.first_name || "them"} how they got into ${hob[0]}.` });
    startB.push({ weight: 12, text: `Ask ${a.first_name || "them"} how they got into ${hob[0]}.` });
  }

  // 6. Location & work preferences -----------------------------------------
  let loc = 0;
  const sameCountry = !!a.country && a.country === b.country;
  const sameCity = sameCountry && !!a.city && a.city.trim().toLowerCase() === (b.city ?? "").trim().toLowerCase();
  if (sameCity) loc = 1; else if (sameCountry) loc = 0.5;
  if (a.work_environment && a.work_environment === b.work_environment) loc = Math.min(1, loc + 0.2);
  if (sameCity && visible(a, "location", ctx) && visible(b, "location", ctx)) {
    const t = `You're both based in ${a.city!.trim()}.`;
    rA.push({ weight: 5, text: t }); rB.push({ weight: 5, text: t });
  }

  const breakdown: Record<WeightKey, number> = {
    goal_complementarity: round3(goal),
    industry_role: round3(industry),
    experience_mentorship: round3(exp),
    professional_interests: round3(proScore),
    personal_interests: round3(hobScore),
    location: round3(loc),
  };
  let total = 0; let wsum = 0;
  for (const k of Object.keys(breakdown) as WeightKey[]) {
    const w = Math.max(0, Number(weights[k] ?? 0));
    total += w * breakdown[k]; wsum += w;
  }
  const score = wsum > 0 ? Math.round((total / wsum) * 10000) / 100 : 0;

  return {
    score,
    breakdown,
    complementary,
    reasonsA: topReasons(rA),
    reasonsB: topReasons(rB),
    starterA: topStarter(startA, b),
    starterB: topStarter(startB, a),
  };
}

function starterFor(goal: string, other: Features): string {
  const n = other.first_name || "them";
  switch (goal) {
    case "find_job": return `Ask ${n} what makes a candidate stand out on their team right now.`;
    case "hire_talent": return `Ask ${n} what kind of role and team they're hoping to find next.`;
    case "find_mentor": return `Ask ${n} what's one piece of advice they wish they'd had earlier.`;
    case "mentor_others": return `Ask ${n} what they're hoping to learn this year.`;
    case "start_company": return `Ask ${n} about the hardest lesson from building a company.`;
    case "advise_founders": return `Ask ${n} what problem they're solving and why now.`;
    case "raise_funding": return `Ask ${n} what they look for before they invest.`;
    case "invest": return `Ask ${n} what traction they're most proud of so far.`;
    case "change_careers": return `Ask ${n} how they'd approach a career change today.`;
    case "share_career_advice": return `Ask ${n} what's drawing them to a new direction.`;
    case "find_cofounder": return `Ask ${n} what they're building and what they need in a co-founder.`;
    default: return `Ask ${n} what brought them here today.`;
  }
}

function topReasons(rs: Reason[]): string[] {
  const seen = new Set<string>();
  return rs
    .slice()
    .sort((x, y) => y.weight - x.weight || x.text.localeCompare(y.text))
    .filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)))
    .slice(0, 3)
    .map((r) => r.text);
}

function topStarter(rs: Reason[], other: Features): string {
  const s = rs.slice().sort((x, y) => y.weight - x.weight || x.text.localeCompare(y.text))[0];
  return s ? s.text : `Ask ${other.first_name || "them"} about the story behind their intro.`;
}

function round3(x: number) {
  return Math.round(x * 1000) / 1000;
}

/** Hard eligibility constraints applied before any scoring. */
export function pairAllowed(a: Features, b: Features, rules: Rules, s: PairScore): boolean {
  if (a.id === b.id) return false;
  if (rules.exclude_same_organisation && a.organisation && b.organisation && a.organisation === b.organisation) return false;
  if (rules.complementary_only && !s.complementary) return false;
  if (rules.recruiters_only_with_seekers) {
    if (has(a.career_goals, "hire_talent") && !has(b.career_goals, "find_job")) return false;
    if (has(b.career_goals, "hire_talent") && !has(a.career_goals, "find_job")) return false;
  }
  return s.score >= rules.min_score;
}

export function normaliseWeights(w: Partial<Weights> | null | undefined): Weights {
  const out = { ...DEFAULT_WEIGHTS };
  if (w) for (const k of Object.keys(out) as WeightKey[]) if (typeof w[k] === "number") out[k] = w[k] as number;
  return out;
}

export function normaliseRules(r: Partial<Rules> | null | undefined): Rules {
  return { ...DEFAULT_RULES, ...(r ?? {}) };
}
