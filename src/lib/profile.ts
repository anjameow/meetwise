// Client-side mirror of public.profile_is_complete() for the progress bar.
// The server remains the source of truth (profile_completed_at).
export interface Profile {
  id: string;
  full_name: string | null;
  photo_path: string | null;
  city: string | null;
  country: string | null;
  education_status: string | null;
  university: string | null;
  graduation_year: number | null;
  organisation: string | null;
  job_title: string | null;
  role_category: string | null;
  industry: string | null;
  employment_status: string | null;
  work_environment: string | null;
  career_stage: string | null;
  career_goals: string[];
  target_roles: string[];
  target_industries: string[];
  skills: string[];
  professional_interests: string[];
  mentorship_preference: string | null;
  quirky_intro: string | null;
  hobbies: string[];
  onboarding_step: number;
  profile_completed_at: string | null;
  privacy_notice_accepted_version: string | null;
}

export const REQUIRED_CHECKS: Array<[string, (p: Profile) => boolean]> = [
  ["Your name", (p) => !!p.full_name?.trim()],
  ["City and country", (p) => !!p.city && !!p.country],
  ["Employment status", (p) => !!p.employment_status],
  ["Career stage", (p) => !!p.career_stage],
  ["Industry", (p) => !!p.industry],
  ["Role", (p) => !!p.role_category],
  ["At least one goal", (p) => p.career_goals.length > 0],
  ["A skill or interest", (p) => p.skills.length + p.professional_interests.length > 0],
  ["Mentorship preference", (p) => !!p.mentorship_preference],
  ["Quirky intro (10+ characters)", (p) => (p.quirky_intro?.trim().length ?? 0) >= 10],
];

const OPTIONAL: Array<(p: Profile) => boolean> = [
  (p) => !!p.photo_path, (p) => !!p.job_title, (p) => !!p.organisation, (p) => !!p.education_status,
  (p) => p.hobbies.length > 0, (p) => p.target_roles.length + p.target_industries.length > 0,
];

export function completion(p: Profile) {
  const req = REQUIRED_CHECKS.filter(([, f]) => f(p)).length;
  const opt = OPTIONAL.filter((f) => f(p)).length;
  const percent = Math.round(((req / REQUIRED_CHECKS.length) * 0.85 + (opt / OPTIONAL.length) * 0.15) * 100);
  return { percent, missing: REQUIRED_CHECKS.filter(([, f]) => !f(p)).map(([l]) => l), requiredDone: req === REQUIRED_CHECKS.length };
}

export const PRIVACY_NOTICE_VERSION = "2026-10-01";
