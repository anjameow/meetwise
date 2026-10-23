import { describe, expect, test } from "vitest";
import { computePrimaryMatching, computeRecommendations, type PoolSnapshot } from "../../supabase/functions/_shared/engine.ts";
import { DEFAULT_RULES, DEFAULT_WEIGHTS, type Features, scorePair } from "../../supabase/functions/_shared/scoring.ts";

let n = 0;
function person(over: Partial<Features> = {}): Features {
  n++;
  return {
    id: over.id ?? `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
    first_name: `P${n}`, organisation: `org${n}`, role_category: "engineering", industry: "technology",
    employment_status: "employed", career_stage: "mid_career", work_environment: "hybrid",
    career_goals: ["expand_network"], target_roles: [], target_industries: [], skills: [], professional_interests: [],
    mentorship_preference: "none", hobbies: [], city: "London", country: "United Kingdom",
    match_visible_fields: ["photo", "location", "hobbies"], recommendation_visible_fields: ["photo"],
    ...over,
  };
}

const snap = (members: Features[], extra: Partial<PoolSnapshot> = {}): PoolSnapshot => ({
  weights: DEFAULT_WEIGHTS, rules: DEFAULT_RULES, members, blocked_pairs: [], excluded_pairs: [], ...extra,
});

describe("scorePair", () => {
  test("is symmetric and bounded", () => {
    const a = person({ career_goals: ["find_job"], target_industries: ["finance"] });
    const b = person({ career_goals: ["hire_talent"], industry: "finance" });
    const ab = scorePair(a, b, DEFAULT_WEIGHTS);
    const ba = scorePair(b, a, DEFAULT_WEIGHTS);
    expect(ab.score).toBe(ba.score);
    expect(ab.reasonsA).toEqual(ba.reasonsB);
    expect(ab.score).toBeGreaterThan(0);
    expect(ab.score).toBeLessThanOrEqual(100);
  });

  test("explains complementarity truthfully from each side", () => {
    const seeker = person({ first_name: "Sam", career_goals: ["find_job"], target_industries: ["finance"] });
    const recruiter = person({ first_name: "Rita", career_goals: ["hire_talent"], industry: "finance" });
    const s = scorePair(seeker, recruiter, DEFAULT_WEIGHTS);
    expect(s.complementary).toBe(true);
    expect(s.reasonsA[0]).toBe("Rita is hiring — and you're looking for your next role.");
    expect(s.reasonsB[0]).toBe("Sam is exploring new roles — and you're hiring.");
    expect(s.starterA).toMatch(/^Ask Rita/);
    expect(s.breakdown.goal_complementarity).toBe(1);
  });

  test("never mentions fields the other person hides", () => {
    const a = person({ hobbies: ["climbing"], match_visible_fields: [] });
    const b = person({ hobbies: ["climbing"] });
    const s = scorePair(a, b, DEFAULT_WEIGHTS, "match");
    expect(s.breakdown.personal_interests).toBeGreaterThan(0); // still counts...
    expect([...s.reasonsA, ...s.reasonsB].join(" ")).not.toMatch(/climbing|London/); // ...but isn't disclosed
  });

  test("weights are configurable", () => {
    const a = person({ hobbies: ["chess", "jazz"] });
    const b = person({ hobbies: ["chess", "jazz"] });
    const onlyHobbies = { ...DEFAULT_WEIGHTS, goal_complementarity: 0, industry_role: 0, experience_mentorship: 0, professional_interests: 0, location: 0, personal_interests: 10 };
    expect(scorePair(a, b, onlyHobbies).score).toBe(100);
  });

  test("mentor fit requires the mentor to be further along", () => {
    const mentee = person({ career_stage: "student", mentorship_preference: "seeking" });
    const mentor = person({ career_stage: "senior", mentorship_preference: "offering" });
    expect(scorePair(mentee, mentor, DEFAULT_WEIGHTS).breakdown.experience_mentorship).toBe(1);
    const juniorMentor = person({ career_stage: "student", mentorship_preference: "offering" });
    expect(scorePair(person({ career_stage: "senior", mentorship_preference: "seeking" }), juniorMentor, DEFAULT_WEIGHTS).breakdown.experience_mentorship).toBe(0.5);
  });
});

describe("computePrimaryMatching", () => {
  test("each person gets at most one match and the result ignores input order", () => {
    const people = Array.from({ length: 9 }, (_, i) => person({
      career_goals: i % 2 ? ["find_job"] : ["hire_talent"], professional_interests: ["AI"], hobbies: i % 3 ? ["chess"] : [],
    }));
    const r1 = computePrimaryMatching(snap(people));
    const r2 = computePrimaryMatching(snap([...people].reverse()));
    expect(r1.pairs).toEqual(r2.pairs);
    const ids = r1.pairs.flatMap((p) => [p.a, p.b]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r1.pairs.length).toBe(4);
    expect(r1.unmatched).toHaveLength(1);
  });

  test("a high-demand recruiter goes to one seeker; others still get the best alternative", () => {
    const recruiter = person({ first_name: "R", career_goals: ["hire_talent"], industry: "finance" });
    const seekers = [1, 2, 3].map(() => person({ career_goals: ["find_job"], target_industries: ["finance"], professional_interests: ["Fintech"] }));
    const peer = person({ career_goals: ["expand_network"], professional_interests: ["Fintech"] });
    const r = computePrimaryMatching(snap([recruiter, ...seekers, peer]));
    const withRecruiter = r.pairs.filter((p) => p.a === recruiter.id || p.b === recruiter.id);
    expect(withRecruiter).toHaveLength(1);
    expect(r.pairs).toHaveLength(2);
  });

  test("does not fabricate matches when the pool is insufficient or incompatible", () => {
    expect(computePrimaryMatching(snap([person()])).pairs).toEqual([]);
    expect(computePrimaryMatching(snap([])).pairs).toEqual([]);
    const a = person({ organisation: "acme" }); const b = person({ organisation: "acme" });
    expect(computePrimaryMatching(snap([a, b])).pairs).toEqual([]); // same organisation excluded
    const c = person(); const d = person();
    expect(computePrimaryMatching(snap([c, d], { blocked_pairs: [[c.id, d.id]] })).pairs).toEqual([]);
    expect(computePrimaryMatching(snap([c, d], { rules: { ...DEFAULT_RULES, min_score: 90 } })).pairs).toEqual([]);
  });

  test("recruiters_only_with_seekers rule", () => {
    const recruiter = person({ career_goals: ["hire_talent"], professional_interests: ["AI"] });
    const nonSeeker = person({ career_goals: ["expand_network"], professional_interests: ["AI"] });
    const rules = { ...DEFAULT_RULES, recruiters_only_with_seekers: true, min_score: 0 };
    expect(computePrimaryMatching(snap([recruiter, nonSeeker], { rules })).pairs).toEqual([]);
  });
});

describe("computeRecommendations", () => {
  test("up to five, excluding self, primary match, blocked and connected people", () => {
    const people = Array.from({ length: 10 }, () => person({ professional_interests: ["AI", "Growth"], career_goals: ["collaborate_projects"] }));
    const [me, primary, blocked, connected] = people;
    const recs = computeRecommendations(snap(people, {
      primary_pairs: [[me.id, primary.id]], blocked_pairs: [[blocked.id, me.id]], connected_pairs: [[me.id, connected.id]],
    }));
    const mine = recs.filter((r) => r.user_id === me.id);
    expect(mine).toHaveLength(5);
    expect(mine.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    const ids = mine.map((r) => r.recommended_user_id);
    for (const x of [me, primary, blocked, connected]) expect(ids).not.toContain(x.id);
    for (let i = 1; i < mine.length; i++) expect(mine[i - 1].score).toBeGreaterThanOrEqual(mine[i].score);
  });

  test("returns fewer than five when fewer candidates exist", () => {
    const people = [person({ professional_interests: ["AI"] }), person({ professional_interests: ["AI"] }), person({ professional_interests: ["AI"] })];
    const recs = computeRecommendations(snap(people));
    expect(recs.filter((r) => r.user_id === people[0].id)).toHaveLength(2);
  });
});
