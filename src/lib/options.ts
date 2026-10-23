// Structured vocabularies. Values must stay in sync with the CHECK constraints
// in supabase/migrations/20261023000001_core_schema.sql.
export type Option = { value: string; label: string };

const o = (pairs: [string, string][]): Option[] => pairs.map(([value, label]) => ({ value, label }));

export const INDUSTRIES = o([
  ["technology", "Technology"], ["finance", "Finance"], ["investment", "Investment & VC"], ["healthcare", "Healthcare"],
  ["biotech", "Biotech & life sciences"], ["education", "Education"], ["consulting", "Consulting"], ["media", "Media & entertainment"],
  ["retail", "Retail & consumer"], ["manufacturing", "Manufacturing"], ["energy", "Energy"], ["climate", "Climate & sustainability"],
  ["government", "Government & public sector"], ["nonprofit", "Nonprofit"], ["legal", "Legal"], ["real_estate", "Real estate"],
  ["hospitality", "Hospitality & travel"], ["transport", "Transport & logistics"], ["telecoms", "Telecoms"], ["other", "Other"],
]);

export const ROLES = o([
  ["engineering", "Engineering"], ["product", "Product"], ["design", "Design"], ["data", "Data & analytics"],
  ["marketing", "Marketing"], ["sales", "Sales & BD"], ["finance", "Finance"], ["operations", "Operations"],
  ["consulting", "Consulting"], ["research", "Research"], ["founder", "Founder"], ["recruiting", "Recruiting & talent"],
  ["legal", "Legal"], ["healthcare", "Clinical & healthcare"], ["education", "Teaching & education"], ["policy", "Policy"],
  ["creative", "Creative"], ["investing", "Investing"], ["other", "Other"],
]);

export const GOALS = o([
  ["find_job", "Find my next role"], ["hire_talent", "Hire great people"], ["find_mentor", "Find a mentor"],
  ["mentor_others", "Mentor someone"], ["start_company", "Start a company"], ["advise_founders", "Share founder experience"],
  ["find_cofounder", "Find a co-founder"], ["raise_funding", "Raise funding"], ["invest", "Invest in startups"],
  ["find_clients", "Find clients"], ["change_careers", "Change careers"], ["share_career_advice", "Share career advice"],
  ["expand_network", "Grow my network"], ["learn_industry", "Learn about an industry"], ["collaborate_projects", "Collaborate on projects"],
]);

export const EDUCATION = o([
  ["high_school", "In high school / sixth form"], ["undergraduate", "Undergraduate student"], ["postgraduate", "Postgraduate student"],
  ["doctoral", "Doctoral student"], ["bootcamp", "Bootcamp / short course"], ["graduated", "Graduated"], ["not_in_education", "Prefer not to say / N/A"],
]);

export const EMPLOYMENT = o([
  ["employed", "Employed"], ["self_employed", "Self-employed"], ["founder", "Founder"], ["student", "Student"],
  ["job_seeking", "Looking for work"], ["freelance", "Freelance / contract"], ["between_roles", "Between roles"], ["other", "Other"],
]);

export const WORK_ENV = o([["on_site", "On-site"], ["hybrid", "Hybrid"], ["remote", "Remote"], ["flexible", "Flexible"]]);

export const STAGES = o([
  ["student", "Student"], ["early_career", "Early career (0–2 yrs)"], ["mid_career", "Mid career (3–7 yrs)"],
  ["senior", "Senior (8–15 yrs)"], ["executive", "Executive / 15+ yrs"],
]);

export const MENTORSHIP = o([
  ["seeking", "I'd love a mentor"], ["offering", "I'd like to mentor"], ["both", "Both"], ["open", "Open to either"], ["none", "Not right now"],
]);

export const PROFILE_FIELDS = o([
  ["photo", "Photo"], ["location", "City & country"], ["education", "Education"], ["organisation", "Organisation"],
  ["job_title", "Job title"], ["hobbies", "Hobbies"],
]);

export const CONTACT_FIELDS = o([["linkedin", "LinkedIn"], ["email", "Email"], ["phone", "Phone"], ["links", "Other links"]]);

export const RESUME_VISIBILITY = o([
  ["nobody", "Only me"], ["match", "My primary match"], ["connections", "Mutual connections"], ["match_and_connections", "My match and mutual connections"],
]);

export const REPORT_CATEGORIES = o([
  ["harassment", "Harassment"], ["inappropriate_content", "Inappropriate content"], ["spam", "Spam or selling"],
  ["fake_profile", "Fake profile"], ["safety_concern", "Safety concern"], ["other", "Something else"],
]);

export const SKILL_SUGGESTIONS = ["Product strategy", "Software engineering", "Data science", "AI / ML", "UX research", "Growth marketing",
  "Fundraising", "Sales", "Public speaking", "Leadership", "Financial modelling", "Operations", "Brand design", "Partnerships", "Policy"];
export const INTEREST_SUGGESTIONS = ["AI", "Fintech", "Climate tech", "Healthtech", "Edtech", "Web3", "Social impact", "Startups",
  "Future of work", "Sustainability", "Creator economy", "Robotics", "Diversity in tech"];
export const HOBBY_SUGGESTIONS = ["Running", "Climbing", "Cooking", "Board games", "Photography", "Hiking", "Live music", "Reading",
  "Cycling", "Yoga", "Travel", "Gaming", "Chess", "Painting", "Football"];

export const COUNTRIES = ["United States", "United Kingdom", "Canada", "Ireland", "Australia", "New Zealand", "Germany", "France",
  "Netherlands", "Spain", "Italy", "Sweden", "Switzerland", "India", "Singapore", "Japan", "South Korea", "China", "Hong Kong",
  "United Arab Emirates", "Nigeria", "Kenya", "South Africa", "Brazil", "Mexico", "Other"];

export function labelOf(list: Option[], v?: string | null) {
  return list.find((x) => x.value === v)?.label ?? v ?? "";
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", registration_open: "Registration open", registration_closed: "Registration closed",
  matching_in_progress: "Matching in progress", primary_ready: "Matches ready", primary_revealed: "Matches revealed",
  event_ended: "Event ended", recommendations_available: "Recommendations live", archived: "Archived",
};

export const WEIGHT_LABELS: Record<string, string> = {
  goal_complementarity: "Career goal complementarity",
  industry_role: "Industry & role relevance",
  experience_mentorship: "Experience & mentorship fit",
  professional_interests: "Shared professional interests",
  personal_interests: "Shared personal interests",
  location: "Location & work preferences",
};

export const TIMEZONES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf("timeZone") as string[];
  } catch {
    return ["UTC", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Singapore"];
  }
})();
