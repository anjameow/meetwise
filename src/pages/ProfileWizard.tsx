import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Camera, CheckCircle2, CloudOff, FileText, Loader2, Trash2, UploadCloud } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import {
  CONTACT_FIELDS, COUNTRIES, EDUCATION, EMPLOYMENT, GOALS, HOBBY_SUGGESTIONS, INDUSTRIES, INTEREST_SUGGESTIONS, MENTORSHIP,
  PROFILE_FIELDS, RESUME_VISIBILITY, ROLES, SKILL_SUGGESTIONS, STAGES, WORK_ENV,
} from "@/lib/options";
import { PRIVACY_NOTICE_VERSION, completion, type Profile } from "@/lib/profile";
import { Button } from "@/components/ui/button";
import { ChipGroup, Field, Input, Select, TagInput, Textarea } from "@/components/ui/form";
import { Avatar, Card, ErrorNote, Progress, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { ProfileCard, type CardProfile } from "@/components/ProfileCard";

interface Contacts { linkedin_url: string | null; email: string | null; phone: string | null; other_links: Array<{ label: string; url: string }> }
interface Privacy { match_visible_fields: string[]; recommendation_visible_fields: string[]; match_contact_fields: string[]; connection_contact_fields: string[]; resume_visibility: string }
interface Resume { storage_path: string; file_name: string; size_bytes: number; uploaded_at: string }

const STEPS = ["Basics", "Education", "Work", "Goals", "Skills", "About you", "Contact", "Privacy", "Preview"];
type SaveState = "idle" | "saving" | "saved" | "error";

/** Debounced autosave of a row the user owns (RLS + column grants enforce this server-side). */
function useAutosave<T extends object>(table: string, key: string, id: string | undefined, onState: (s: SaveState) => void) {
  const pending = React.useRef<Partial<T>>({});
  const timer = React.useRef<number>();
  const flushRef = React.useRef<() => Promise<void>>(async () => {});
  const flush = React.useCallback(async () => {
    if (!id || Object.keys(pending.current).length === 0) return;
    const patch = pending.current; pending.current = {};
    onState("saving");
    const { error } = await supabase.from(table).update(patch as Record<string, unknown>).eq(key, id);
    if (error) {
      // Keep the change and retry (e.g. after a dropped connection).
      pending.current = { ...patch, ...pending.current };
      onState("error");
      toast.error(friendlyError(error), { id: `autosave-${table}` });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flushRef.current(), 5000);
    } else onState("saved");
  }, [id, key, table, onState]);
  flushRef.current = flush;
  const queue = React.useCallback((patch: Partial<T>) => {
    pending.current = { ...pending.current, ...patch };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  }, [flush]);
  React.useEffect(() => () => { window.clearTimeout(timer.current); void flush(); }, [flush]);
  return { queue, flush };
}

export default function ProfileWizard() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const uid = user?.id;

  const data = useQuery({
    queryKey: ["my_profile", uid],
    enabled: !!uid,
    queryFn: async () => {
      const [p, c, s, r] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", uid!).single(),
        supabase.from("profile_contacts").select("*").eq("user_id", uid!).single(),
        supabase.from("privacy_settings").select("*").eq("user_id", uid!).single(),
        supabase.from("resumes").select("*").eq("user_id", uid!).maybeSingle(),
      ]);
      if (p.error) throw p.error;
      return { profile: p.data as Profile, contacts: c.data as Contacts, privacy: s.data as Privacy, resume: r.data as Resume | null };
    },
  });

  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [contacts, setContacts] = React.useState<Contacts | null>(null);
  const [privacy, setPrivacy] = React.useState<Privacy | null>(null);
  const [resume, setResume] = React.useState<Resume | null>(null);
  const [step, setStep] = React.useState(0);
  const [save, setSave] = React.useState<SaveState>("idle");

  React.useEffect(() => {
    if (data.data && !profile) {
      setProfile(data.data.profile); setContacts(data.data.contacts); setPrivacy(data.data.privacy); setResume(data.data.resume);
      setStep(Math.min(data.data.profile.onboarding_step ?? 0, STEPS.length - 1));
    }
  }, [data.data, profile]);

  const pSave = useAutosave<Profile>("profiles", "id", uid, setSave);
  const cSave = useAutosave<Contacts>("profile_contacts", "user_id", uid, setSave);
  const sSave = useAutosave<Privacy>("privacy_settings", "user_id", uid, setSave);

  if (data.isLoading || !profile || !contacts || !privacy) return data.error ? <div className="page"><ErrorNote>{friendlyError(data.error)}</ErrorNote></div> : <Spinner />;

  const setP = (patch: Partial<Profile>) => { setProfile((p) => ({ ...p!, ...patch })); pSave.queue(patch); };
  const setC = (patch: Partial<Contacts>) => { setContacts((c) => ({ ...c!, ...patch })); cSave.queue(patch); };
  const setS = (patch: Partial<Privacy>) => { setPrivacy((s) => ({ ...s!, ...patch })); sSave.queue(patch); };
  const comp = completion(profile);

  const go = async (to: number) => {
    await Promise.all([pSave.flush(), cSave.flush(), sSave.flush()]);
    setStep(to);
    if (to > (profile.onboarding_step ?? 0)) setP({ onboarding_step: to });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const finish = async () => {
    setP({ privacy_notice_accepted_version: PRIVACY_NOTICE_VERSION });
    await Promise.all([pSave.flush(), cSave.flush(), sSave.flush()]);
    const { data: fresh } = await supabase.from("profiles").select("profile_completed_at").eq("id", uid!).single();
    qc.invalidateQueries();
    if (!fresh?.profile_completed_at) { toast.error("A few required details are still missing."); return; }
    toast.success("Profile complete!");
    nav(next && next.startsWith("/") && !next.startsWith("//") ? next : "/events");
  };

  return (
    <div className="page">
      <div className="sticky top-16 z-30 -mx-5 mb-6 border-b border-navy-100/60 bg-cream-100/90 px-5 pb-3 pt-2 backdrop-blur">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold">Step {step + 1} of {STEPS.length} · {STEPS[step]}</span>
          <SaveIndicator state={save} />
        </div>
        <Progress value={comp.percent} className="mt-2" label="Profile completion" />
        <p className="mt-1 text-xs text-navy-500">{comp.percent}% complete{comp.missing.length ? ` · Needed: ${comp.missing.slice(0, 2).join(", ")}${comp.missing.length > 2 ? "…" : ""}` : " · Ready to match"}</p>
      </div>

      <div key={step} className="animate-fade-in space-y-5">
        {step === 0 && <>
          <StepTitle title="Let's start with you" sub="Just the basics. You decide later what others can see." />
          <PhotoUpload uid={uid!} name={profile.full_name} path={profile.photo_path} onChange={(photo_path) => setP({ photo_path })} />
          <Field label="Full name" htmlFor="name"><Input id="name" autoComplete="name" maxLength={80} value={profile.full_name ?? ""} onChange={(e) => setP({ full_name: e.target.value || null })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="City" htmlFor="city"><Input id="city" autoComplete="address-level2" maxLength={80} value={profile.city ?? ""} onChange={(e) => setP({ city: e.target.value || null })} /></Field>
            <Field label="Country" htmlFor="country"><Select id="country" options={COUNTRIES} value={profile.country ?? ""} onValueChange={(v) => setP({ country: v || null })} /></Field>
          </div>
        </>}

        {step === 1 && <>
          <StepTitle title="Education" sub="Optional, but helpful for students and recent grads." />
          <Field label="Education status" htmlFor="edu" optional><Select id="edu" options={EDUCATION} value={profile.education_status ?? ""} onValueChange={(v) => setP({ education_status: v || null })} /></Field>
          <Field label="University or school" htmlFor="uni" optional><Input id="uni" maxLength={120} value={profile.university ?? ""} onChange={(e) => setP({ university: e.target.value || null })} /></Field>
          <Field label="Graduation year" htmlFor="grad" optional>
            <Select id="grad" options={Array.from({ length: 50 }, (_, i) => String(2035 - i))} value={profile.graduation_year ? String(profile.graduation_year) : ""}
              onValueChange={(v) => setP({ graduation_year: v ? Number(v) : null })} />
          </Field>
        </>}

        {step === 2 && <>
          <StepTitle title="Work" sub="Your current situation — whatever it looks like." />
          <Field label="Employment status" htmlFor="emp"><Select id="emp" options={EMPLOYMENT} value={profile.employment_status ?? ""} onValueChange={(v) => setP({ employment_status: v || null })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Organisation" htmlFor="org" optional><Input id="org" autoComplete="organization" maxLength={120} value={profile.organisation ?? ""} onChange={(e) => setP({ organisation: e.target.value || null })} /></Field>
            <Field label="Job title" htmlFor="title" optional><Input id="title" autoComplete="organization-title" maxLength={100} value={profile.job_title ?? ""} onChange={(e) => setP({ job_title: e.target.value || null })} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role" htmlFor="role"><Select id="role" options={ROLES} value={profile.role_category ?? ""} onValueChange={(v) => setP({ role_category: v || null })} /></Field>
            <Field label="Industry" htmlFor="ind"><Select id="ind" options={INDUSTRIES} value={profile.industry ?? ""} onValueChange={(v) => setP({ industry: v || null })} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Career stage" htmlFor="stage"><Select id="stage" options={STAGES} value={profile.career_stage ?? ""} onValueChange={(v) => setP({ career_stage: v || null })} /></Field>
            <Field label="Work environment" htmlFor="env" optional><Select id="env" options={WORK_ENV} value={profile.work_environment ?? ""} onValueChange={(v) => setP({ work_environment: v || null })} /></Field>
          </div>
        </>}

        {step === 3 && <>
          <StepTitle title="What are you here for?" sub="This drives matching the most. Pick up to five." />
          <Field label="Your goals"><ChipGroup label="Career goals" options={GOALS} value={profile.career_goals} max={5} onChange={(career_goals) => setP({ career_goals })} /></Field>
          <Field label="Roles you're interested in" optional hint="Roles you'd like to work in or meet people from."><ChipGroup label="Target roles" options={ROLES} value={profile.target_roles} max={5} onChange={(target_roles) => setP({ target_roles })} /></Field>
          <Field label="Industries you're targeting" optional><ChipGroup label="Target industries" options={INDUSTRIES} value={profile.target_industries} max={5} onChange={(target_industries) => setP({ target_industries })} /></Field>
          <Field label="Mentorship"><ChipGroup label="Mentorship preference" options={MENTORSHIP} value={profile.mentorship_preference ? [profile.mentorship_preference] : []} max={1}
            onChange={(v) => setP({ mentorship_preference: v[v.length - 1] ?? null })} /></Field>
        </>}

        {step === 4 && <>
          <StepTitle title="Skills & interests" sub="Add at least one skill or professional interest." />
          <Field label="Skills" htmlFor="skills"><TagInput id="skills" value={profile.skills} max={15} suggestions={SKILL_SUGGESTIONS} onChange={(skills) => setP({ skills })} /></Field>
          <Field label="Professional interests" htmlFor="pi"><TagInput id="pi" value={profile.professional_interests} max={10} suggestions={INTEREST_SUGGESTIONS} onChange={(professional_interests) => setP({ professional_interests })} /></Field>
        </>}

        {step === 5 && <>
          <StepTitle title="The fun part" sub="A quirky intro makes you memorable — and gives your match an easy opener." />
          <Field label="Quirky intro" htmlFor="intro" hint={`${profile.quirky_intro?.length ?? 0}/160 · e.g. "Ex-barista who now builds payment APIs. Will debate the best pastry in any city."`}>
            <Textarea id="intro" maxLength={160} value={profile.quirky_intro ?? ""} onChange={(e) => setP({ quirky_intro: e.target.value || null })} />
          </Field>
          <Field label="Hobbies & personal interests" htmlFor="hob" optional><TagInput id="hob" value={profile.hobbies} max={10} suggestions={HOBBY_SUGGESTIONS} onChange={(hobbies) => setP({ hobbies })} /></Field>
        </>}

        {step === 6 && <>
          <StepTitle title="Contact & résumé" sub="All optional and private. Nothing here is shared unless you allow it on the next step." />
          <Field label="LinkedIn URL" htmlFor="li" optional hint="https://www.linkedin.com/in/…"><Input id="li" type="url" inputMode="url" value={contacts.linkedin_url ?? ""} onChange={(e) => setC({ linkedin_url: e.target.value.trim() || null })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email to share" htmlFor="em" optional><Input id="em" type="email" autoComplete="email" value={contacts.email ?? ""} onChange={(e) => setC({ email: e.target.value.trim() || null })} /></Field>
            <Field label="Phone" htmlFor="ph" optional><Input id="ph" type="tel" autoComplete="tel" value={contacts.phone ?? ""} onChange={(e) => setC({ phone: e.target.value || null })} /></Field>
          </div>
          <LinksEditor links={contacts.other_links} onChange={(other_links) => setC({ other_links })} />
          <ResumeUpload uid={uid!} resume={resume} onChange={setResume} />
        </>}

        {step === 7 && <>
          <StepTitle title="Your privacy" sub="Name, role, industry, goals, interests and intro are always shown so matches make sense. Everything else is your call." />
          <Card className="p-5">
            <h3 className="font-semibold">Your primary match can see</h3>
            <FieldToggles value={privacy.match_visible_fields} onChange={(match_visible_fields) => setS({ match_visible_fields })} />
            <h3 className="mt-5 font-semibold">Share with your match automatically</h3>
            <p className="text-sm text-navy-500">Off by default. You can always connect afterwards instead.</p>
            <ContactToggles value={privacy.match_contact_fields} onChange={(match_contact_fields) => setS({ match_contact_fields })} />
          </Card>
          <Card className="p-5">
            <h3 className="font-semibold">Post-event recommendations can see</h3>
            <p className="text-sm text-navy-500">Contact details are never shown in recommendations.</p>
            <FieldToggles value={privacy.recommendation_visible_fields} onChange={(recommendation_visible_fields) => setS({ recommendation_visible_fields })} />
          </Card>
          <Card className="p-5">
            <h3 className="font-semibold">Mutual connections can see</h3>
            <ContactToggles value={privacy.connection_contact_fields} onChange={(connection_contact_fields) => setS({ connection_contact_fields })} />
            <Field label="Who can open your résumé" htmlFor="rv" className="mt-4"><Select id="rv" options={RESUME_VISIBILITY} value={privacy.resume_visibility} onValueChange={(v) => setS({ resume_visibility: v || "nobody" })} /></Field>
          </Card>
        </>}

        {step === 8 && <Preview percent={comp.percent} missing={comp.missing} onEdit={(s) => go(s)} />}
      </div>

      <div className="mt-8 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => go(Math.max(0, step - 1))} disabled={step === 0}><ArrowLeft className="h-4 w-4" />Back</Button>
        {step < STEPS.length - 1
          ? <Button onClick={() => go(step + 1)}>Continue<ArrowRight className="h-4 w-4" /></Button>
          : <Button variant="gold" size="lg" onClick={finish} disabled={!comp.requiredDone}>Finish profile</Button>}
      </div>
      {step === STEPS.length - 1 && (
        <p className="mt-3 text-center text-xs text-navy-400">By finishing you confirm you've read the <a href="/privacy" className="underline">privacy notice</a>.</p>
      )}
    </div>
  );
}

function StepTitle({ title, sub }: { title: string; sub: string }) {
  return <div><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-navy-500">{sub}</p></div>;
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") return <span className="flex items-center gap-1 text-navy-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving</span>;
  if (state === "saved") return <span className="flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Saved</span>;
  if (state === "error") return <span className="flex items-center gap-1 text-red-700"><CloudOff className="h-3.5 w-3.5" />Not saved — will retry</span>;
  return <span className="text-navy-400">Autosaves as you go</span>;
}

function FieldToggles({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return <div className="mt-3"><ChipGroup label="Visible fields" options={PROFILE_FIELDS} value={value} onChange={onChange} /></div>;
}
function ContactToggles({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return <div className="mt-3"><ChipGroup label="Shared contact details" options={CONTACT_FIELDS} value={value} onChange={onChange} /></div>;
}

function LinksEditor({ links, onChange }: { links: Array<{ label: string; url: string }>; onChange: (l: Array<{ label: string; url: string }>) => void }) {
  const [label, setLabel] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const add = () => {
    try {
      const u = new URL(url.trim());
      if (u.protocol !== "https:") throw new Error();
      onChange([...links, { label: label.trim().slice(0, 40) || u.hostname, url: u.toString() }]);
      setLabel(""); setUrl(""); setErr(null);
    } catch { setErr("Use a full https:// link"); }
  };
  return (
    <Field label="Other links" optional hint="Portfolio, GitHub, personal site (up to 3)" error={err}>
      <ul className="space-y-1.5">
        {links.map((l, i) => (
          <li key={l.url} className="flex items-center justify-between rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-navy-100">
            <span className="truncate">{l.label} · <span className="text-navy-400">{l.url}</span></span>
            <button aria-label={`Remove ${l.label}`} onClick={() => onChange(links.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4 text-navy-400" /></button>
          </li>
        ))}
      </ul>
      {links.length < 3 && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input aria-label="Link label" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} className="sm:w-36" />
          <Input aria-label="Link URL" placeholder="https://" type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button variant="outline" onClick={add} disabled={!url}>Add</Button>
        </div>
      )}
    </Field>
  );
}

const rand = () => Math.random().toString(36).slice(2, 10);

function PhotoUpload({ uid, name, path, onChange }: { uid: string; name: string | null; path: string | null; onChange: (p: string | null) => void }) {
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) return toast.error("Use a JPG, PNG or WebP image");
    if (f.size > 2 * 1024 * 1024) return toast.error("Photos must be under 2 MB");
    setBusy(true);
    const ext = f.type.split("/")[1].replace("jpeg", "jpg");
    const newPath = `${uid}/${rand()}${rand()}.${ext}`;
    const { error } = await supabase.storage.from("avatars").upload(newPath, f, { contentType: f.type, upsert: false });
    setBusy(false);
    if (error) return toast.error("Upload failed — check your connection and try again.");
    if (path) await supabase.storage.from("avatars").remove([path]);
    onChange(newPath);
  };
  return (
    <div className="flex items-center gap-4">
      <Avatar name={name} path={path} size={72} />
      <div className="flex gap-2">
        <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Upload photo"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        <Button variant="outline" size="sm" loading={busy} onClick={() => ref.current?.click()}><Camera className="h-4 w-4" />{path ? "Change photo" : "Add photo"}</Button>
        {path && <Button variant="ghost" size="sm" onClick={async () => { await supabase.storage.from("avatars").remove([path]); onChange(null); }}>Remove</Button>}
      </div>
    </div>
  );
}

function ResumeUpload({ uid, resume, onChange }: { uid: string; resume: Resume | null; onChange: (r: Resume | null) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<File | null>(null);
  const ref = React.useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    if (f.type !== "application/pdf") return toast.error("Résumés must be PDF files");
    if (f.size > 5 * 1024 * 1024) return toast.error("Résumés must be under 5 MB");
    setBusy(true); setFailed(null);
    const path = `${uid}/${rand()}${rand()}.pdf`;
    try {
      const { error } = await supabase.storage.from("resumes").upload(path, f, { contentType: "application/pdf", upsert: false });
      if (error) throw error;
      const res = await rpc<{ previous_path: string | null }>("record_resume_upload", { p_path: path, p_file_name: f.name.slice(0, 200), p_size: f.size });
      if (res.previous_path) await supabase.storage.from("resumes").remove([res.previous_path]);
      onChange({ storage_path: path, file_name: f.name, size_bytes: f.size, uploaded_at: new Date().toISOString() });
      toast.success("Résumé uploaded — it stays private until you choose who can see it.");
    } catch (e) {
      await supabase.storage.from("resumes").remove([path]);
      setFailed(f);
      toast.error(friendlyError(e) === "Something went wrong. Please try again." ? "Upload failed. Please retry." : friendlyError(e));
    } finally { setBusy(false); }
  };
  const remove = async () => {
    const p = await rpc<string | null>("delete_resume");
    if (p) await supabase.storage.from("resumes").remove([p]);
    onChange(null);
  };
  return (
    <Field label="Résumé (PDF)" optional hint="Private storage. Viewers get a link that expires after 2 minutes.">
      {resume ? (
        <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3 ring-1 ring-navy-100">
          <span className="flex items-center gap-2 text-sm"><FileText className="h-4 w-4" />{resume.file_name}</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => ref.current?.click()}>Replace</Button>
            <Button variant="ghost" size="sm" onClick={remove}>Remove</Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()} className="flex w-full flex-col items-center rounded-2xl border-2 border-dashed border-navy-200 bg-white py-6 text-sm text-navy-500 hover:border-navy-400">
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <UploadCloud className="h-6 w-6" />}<span className="mt-1">Upload PDF (max 5 MB)</span>
        </button>
      )}
      {failed && <Button variant="outline" size="sm" onClick={() => upload(failed)}>Retry upload</Button>}
      <input ref={ref} type="file" accept="application/pdf" className="sr-only" aria-label="Upload résumé"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
    </Field>
  );
}

function Preview({ percent, missing, onEdit }: { percent: number; missing: string[]; onEdit: (step: number) => void }) {
  const [ctx, setCtx] = React.useState("match");
  const q = useQuery({ queryKey: ["preview", ctx], queryFn: () => rpc<CardProfile>("get_profile_preview", { p_context: ctx }) });
  return (
    <div className="space-y-4">
      <StepTitle title="Preview" sub="Exactly what others will see, rendered with the same server rules." />
      {missing.length > 0 && (
        <ErrorNote>Still needed: {missing.join(", ")}. <button className="font-semibold underline" onClick={() => onEdit(0)}>Go back</button></ErrorNote>
      )}
      <Tabs value={ctx} onValueChange={setCtx}>
        <TabsList><TabsTrigger value="match">As your match</TabsTrigger><TabsTrigger value="recommendation">In recommendations</TabsTrigger><TabsTrigger value="connection">As a connection</TabsTrigger></TabsList>
        <TabsContent value={ctx} className="mt-4">{q.data ? <ProfileCard p={q.data} /> : <Spinner />}</TabsContent>
      </Tabs>
      <p className="flex items-center gap-2 rounded-xl bg-white p-4 text-sm text-navy-700 ring-1 ring-navy-100">
        <CheckCircle2 className={missing.length === 0 ? "h-5 w-5 text-emerald-700" : "h-5 w-5 text-navy-300"} aria-hidden />
        {missing.length === 0 ? `All required details are in (${percent}% overall). You're ready to be matched.` : "Complete the required details to be included in matching."}
      </p>
    </div>
  );
}
