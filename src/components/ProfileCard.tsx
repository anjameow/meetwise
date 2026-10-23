import * as React from "react";
import { Briefcase, FileText, GraduationCap, Link2, Mail, MapPin, Phone, Sparkles } from "lucide-react";
import { EDUCATION, EMPLOYMENT, GOALS, INDUSTRIES, MENTORSHIP, ROLES, STAGES, labelOf } from "@/lib/options";
import { cn } from "@/lib/utils";
import { Avatar, Badge } from "./ui/misc";

/** Shape returned by private.profile_card(): hidden fields are simply absent. */
export interface CardProfile {
  id: string;
  full_name: string | null;
  first_name?: string;
  photo_path?: string | null;
  city?: string | null;
  country?: string | null;
  education_status?: string | null;
  university?: string | null;
  graduation_year?: number | null;
  organisation?: string | null;
  job_title?: string | null;
  role_category?: string | null;
  industry?: string | null;
  employment_status?: string | null;
  career_stage?: string | null;
  career_goals?: string[];
  target_roles?: string[];
  target_industries?: string[];
  skills?: string[];
  professional_interests?: string[];
  mentorship_preference?: string | null;
  quirky_intro?: string | null;
  hobbies?: string[];
  contacts?: { linkedin?: string; email?: string; phone?: string; links?: Array<{ label?: string; url: string }> };
  resume_available?: boolean;
}

export function ProfileCard({ p, variant = "full", className, footer, onResume, highlight }: {
  p: CardProfile; variant?: "full" | "compact"; className?: string; footer?: React.ReactNode;
  onResume?: () => void; highlight?: React.ReactNode;
}) {
  const role = p.job_title || labelOf(ROLES, p.role_category);
  const where = p.organisation || labelOf(EMPLOYMENT, p.employment_status);
  const interests = [...(p.professional_interests ?? []), ...(p.skills ?? [])]
    .filter((t, i, all) => all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
    .slice(0, variant === "full" ? 8 : 4);
  const contacts = p.contacts ?? {};
  const hasContacts = !!(contacts.linkedin || contacts.email || contacts.phone || contacts.links?.length);

  return (
    <article className={cn("relative overflow-hidden rounded-3xl bg-white shadow-card ring-1 ring-navy-100", className)} aria-label={`Profile of ${p.full_name ?? "attendee"}`}>
      <div className="relative bg-navy-900 px-6 pb-14 pt-6 text-cream-50">
        <div aria-hidden className="absolute inset-0 opacity-40 [background:radial-gradient(120%_80%_at_100%_0%,rgba(212,168,75,.45),transparent_55%)]" />
        <div className="relative flex items-center gap-2">
          {p.industry && <Badge className="bg-white/10 text-cream-50">{labelOf(INDUSTRIES, p.industry)}</Badge>}
          {p.career_stage && <Badge className="bg-white/10 text-cream-50">{labelOf(STAGES, p.career_stage).split(" (")[0]}</Badge>}
        </div>
      </div>
      <div className="relative -mt-10 px-6">
        <Avatar name={p.full_name} path={p.photo_path} size={80} className="ring-4 ring-white" />
        <h3 className="mt-3 font-display text-2xl font-semibold leading-tight">{p.full_name}</h3>
        <p className="mt-0.5 flex items-center gap-1.5 text-navy-600"><Briefcase className="h-4 w-4 shrink-0" aria-hidden />
          <span>{role}{where ? <> · <span className="text-navy-500">{where}</span></> : null}</span></p>
        {(p.city || p.country) && (
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-navy-500"><MapPin className="h-4 w-4" aria-hidden />{[p.city, p.country].filter(Boolean).join(", ")}</p>
        )}
        {p.university && variant === "full" && (
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-navy-500"><GraduationCap className="h-4 w-4" aria-hidden />
            {p.university}{p.graduation_year ? ` · ${p.graduation_year}` : ""}{p.education_status && !p.graduation_year ? ` · ${labelOf(EDUCATION, p.education_status)}` : ""}</p>
        )}
      </div>

      {p.quirky_intro && (
        <blockquote className="mx-6 mt-4 rounded-2xl bg-cream-100 px-4 py-3 font-display text-[17px] italic leading-snug text-navy-800">
          “{p.quirky_intro}”
        </blockquote>
      )}

      {highlight && <div className="mx-6 mt-4">{highlight}</div>}

      <div className="space-y-4 px-6 py-5">
        {!!p.career_goals?.length && (
          <section>
            <h4 className="eyebrow mb-2">Here to</h4>
            <div className="flex flex-wrap gap-1.5">{p.career_goals.map((g) => <Badge key={g} tone="gold">{labelOf(GOALS, g)}</Badge>)}</div>
          </section>
        )}
        {interests.length > 0 && (
          <section>
            <h4 className="eyebrow mb-2">Into</h4>
            <div className="flex flex-wrap gap-1.5">{interests.map((t) => <Badge key={t}>{t}</Badge>)}</div>
          </section>
        )}
        {variant === "full" && !!p.hobbies?.length && (
          <section>
            <h4 className="eyebrow mb-2">Off the clock</h4>
            <p className="text-sm text-navy-700">{p.hobbies.join(" · ")}</p>
          </section>
        )}
        {variant === "full" && p.mentorship_preference && p.mentorship_preference !== "none" && (
          <p className="flex items-center gap-1.5 text-sm text-navy-600"><Sparkles className="h-4 w-4 text-gold-500" aria-hidden />Mentorship: {labelOf(MENTORSHIP, p.mentorship_preference)}</p>
        )}
        {hasContacts && (
          <section className="rounded-2xl border border-gold-200 bg-gold-100/40 p-4">
            <h4 className="eyebrow mb-2">Shared with you</h4>
            <ul className="space-y-1.5 text-sm">
              {contacts.linkedin && <li><a className="flex items-center gap-2 font-medium text-navy-800 hover:underline" href={contacts.linkedin} target="_blank" rel="noopener noreferrer"><Link2 className="h-4 w-4" />LinkedIn</a></li>}
              {contacts.email && <li><a className="flex items-center gap-2 font-medium text-navy-800 hover:underline" href={`mailto:${contacts.email}`}><Mail className="h-4 w-4" />{contacts.email}</a></li>}
              {contacts.phone && <li><a className="flex items-center gap-2 font-medium text-navy-800 hover:underline" href={`tel:${contacts.phone}`}><Phone className="h-4 w-4" />{contacts.phone}</a></li>}
              {contacts.links?.map((l) => <li key={l.url}><a className="flex items-center gap-2 font-medium text-navy-800 hover:underline" href={l.url} target="_blank" rel="noopener noreferrer"><Link2 className="h-4 w-4" />{l.label || l.url}</a></li>)}
            </ul>
          </section>
        )}
        {p.resume_available && onResume && (
          <button onClick={onResume} className="flex items-center gap-2 text-sm font-semibold text-navy-800 hover:underline"><FileText className="h-4 w-4" />View résumé (link expires in 2 minutes)</button>
        )}
      </div>
      {footer && <div className="border-t border-navy-100 px-6 py-4">{footer}</div>}
    </article>
  );
}
