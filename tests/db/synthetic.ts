// Deterministic synthetic attendees for end-to-end tests (never used by the app).
import { as, createUser } from "./harness.ts";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ava", "Ben", "Chloe", "Dev", "Elena", "Femi", "Grace", "Hiro", "Isla", "Jonah", "Kemi", "Leo", "Maya",
  "Nikhil", "Olga", "Priya", "Quinn", "Rosa", "Sam", "Tariq", "Uma", "Victor", "Wren", "Xavier", "Yara", "Zane"];
const INDUSTRIES = ["technology", "finance", "healthcare", "climate", "education", "consulting", "media"];
const ROLES = ["engineering", "product", "design", "data", "marketing", "sales", "finance", "recruiting", "founder"];
const GOALS = ["find_job", "hire_talent", "find_mentor", "mentor_others", "start_company", "advise_founders",
  "find_cofounder", "raise_funding", "invest", "expand_network", "learn_industry", "collaborate_projects"];
const STAGES = ["student", "early_career", "mid_career", "senior", "executive"];
const INTERESTS = ["AI", "Product strategy", "Fintech", "Climate tech", "UX research", "Growth", "Data science",
  "Public speaking", "Leadership", "Web3", "Healthtech", "Sustainability"];
const HOBBIES = ["climbing", "running", "chess", "baking", "jazz", "photography", "hiking", "board games", "cycling"];
const CITIES: Array<[string, string]> = [["London", "United Kingdom"], ["Manchester", "United Kingdom"], ["Berlin", "Germany"]];

function pick<T>(r: () => number, xs: T[]): T { return xs[Math.floor(r() * xs.length)]; }
function some<T>(r: () => number, xs: T[], n: number): T[] {
  const copy = [...xs]; const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(r() * copy.length), 1)[0]);
  return out;
}

export function syntheticProfile(i: number, seed = 42) {
  const r = prng(seed * 1000 + i);
  const [city, country] = pick(r, CITIES);
  const stage = pick(r, STAGES);
  return {
    full_name: `${FIRST[i % FIRST.length]} Test${i}`,
    city, country,
    education_status: stage === "student" ? "undergraduate" : "graduated",
    university: "Synthetic University",
    graduation_year: 2010 + Math.floor(r() * 16),
    organisation: `Org ${Math.floor(r() * 8)}`,
    job_title: "Synthetic role",
    role_category: pick(r, ROLES),
    industry: pick(r, INDUSTRIES),
    employment_status: stage === "student" ? "student" : "employed",
    work_environment: pick(r, ["on_site", "hybrid", "remote"]),
    career_stage: stage,
    career_goals: some(r, GOALS, 1 + Math.floor(r() * 3)),
    target_roles: some(r, ROLES, 2),
    target_industries: some(r, INDUSTRIES, 2),
    skills: some(r, INTERESTS, 2),
    professional_interests: some(r, INTERESTS, 2),
    mentorship_preference: pick(r, ["seeking", "offering", "both", "open", "none"]),
    quirky_intro: `Synthetic attendee #${i} who once ate a whole pineapple`,
    hobbies: some(r, HOBBIES, 2),
  };
}

export async function updateProfile(uid: string, p: Record<string, unknown>) {
  const keys = Object.keys(p);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await as(uid).query(`update public.profiles set ${sets.join(", ")} where id = $1`, [uid, ...keys.map((k) => p[k])]);
}

export async function createSyntheticAttendee(i: number, overrides: Record<string, unknown> = {}) {
  const uid = await createUser(`attendee${i}@example.test`, `Attendee ${i}`);
  await updateProfile(uid, { ...syntheticProfile(i), ...overrides });
  return uid;
}
