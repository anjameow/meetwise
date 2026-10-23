import * as React from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { useEventBySlug } from "@/hooks/useEvent";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { supabase } from "@/lib/supabase";
import { PRIVACY_NOTICE_VERSION } from "@/lib/profile";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { ErrorNote, Spinner } from "@/components/ui/misc";

export default function JoinEvent() {
  const { slug } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useEventBySlug(slug);
  const [matching, setMatching] = React.useState(true);
  const [recs, setRecs] = React.useState(true);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (q.isLoading) return <Spinner />;
  if (!q.data) return <Navigate to={`/e/${slug}`} replace />;
  const { event, registration } = q.data;
  if (registration && ["registered", "checked_in"].includes(registration.status)) return <Navigate to={`/e/${slug}/hub`} replace />;

  const join = async () => {
    setBusy(true); setError(null);
    try {
      await rpc("register_for_event", {
        p_slug: slug, p_matching_consent: matching, p_recommendations_opt_in: recs,
        p_access_code: event.requires_access_code ? code.trim() : null, p_consent_version: PRIVACY_NOTICE_VERSION,
      });
      qc.invalidateQueries({ queryKey: ["event_public", slug] });
      const { data: prof } = await supabase.from("profiles").select("profile_completed_at").single();
      toast.success(`You're in for ${event.name}!`);
      nav(prof?.profile_completed_at ? `/e/${slug}/hub` : `/profile?next=${encodeURIComponent(`/e/${slug}/hub`)}`);
    } catch (e) {
      setError(friendlyError(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <p className="eyebrow">Joining</p>
      <h1 className="mt-1 text-3xl font-semibold">{event.name}</h1>
      <p className="mt-2 text-navy-500">Two quick choices. You can change them any time before the reveal.</p>

      <div className="card mt-6 divide-y divide-navy-100 px-5">
        <Switch checked={matching} onChange={setMatching} label="Match me with one person at this event"
          description="We'll use your professional profile to pick one attendee for you to meet. Without this you won't receive a primary match." />
        <Switch checked={recs} onChange={setRecs} label="Include me in post-event recommendations"
          description="You'll appear in (and receive) up to five recommendations after the event. Contact details are only shared after you both agree." />
      </div>

      {event.requires_access_code && (
        <Field label="Event access code" htmlFor="code" hint="The organiser shares this at the venue." className="mt-5">
          <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" maxLength={32} />
        </Field>
      )}

      <div className="mt-5 flex gap-3 rounded-2xl bg-white p-4 text-sm text-navy-600 ring-1 ring-navy-100">
        <ShieldCheck className="h-5 w-5 shrink-0 text-navy-700" aria-hidden />
        <p>The organiser sees your name, role and registration status — never your contact details or résumé.
          Matching never uses age, gender, ethnicity or other sensitive characteristics. <Link to="/privacy" className="font-semibold underline">Read the privacy notice</Link>.</p>
      </div>

      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <Button size="lg" variant="gold" className="mt-6 w-full" loading={busy} onClick={join}>Join event</Button>
    </div>
  );
}
