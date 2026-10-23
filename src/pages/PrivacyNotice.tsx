import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { PRIVACY_NOTICE_VERSION } from "@/lib/profile";

export default function PrivacyNotice() {
  const retention = useQuery({
    queryKey: ["retention"],
    queryFn: async () => (await supabase.from("platform_settings").select("value").eq("key", "retention").maybeSingle()).data?.value as Record<string, number> | undefined,
  });
  const r = retention.data;
  return (
    <div className="page prose-sm">
      <p className="eyebrow">Version {PRIVACY_NOTICE_VERSION}</p>
      <h1 className="mt-1 text-3xl font-semibold">Privacy notice</h1>
      <div className="mt-6 space-y-5 text-[15px] leading-relaxed text-navy-700">
        <Section title="What we collect">Your account email; the professional profile you fill in (name, location, education, work, goals, skills, interests, mentorship preferences, quirky intro, hobbies); optional photo, résumé and contact details; your event registrations and choices; feedback you give.</Section>
        <Section title="What we never collect or use">We don't ask for your date of birth or age, and we never collect or use sensitive characteristics such as gender, ethnicity, religion, health, sexuality or political views for matching.</Section>
        <Section title="How matching works">Only if you consent per event. We score pairs on career-goal complementarity, industry and role relevance, experience and mentorship fit, shared professional and personal interests, and location. Organisers can adjust these weights. The reasons we show you are generated from the actual overlap between your profiles.</Section>
        <Section title="Who sees what">
          <ul className="list-disc pl-5">
            <li>Your primary match sees the fields you allow for matches, plus any contact details you chose to share automatically.</li>
            <li>Post-event recommendations show the fields you allow for recommendations, never contact details.</li>
            <li>Contact details are exchanged after both of you agree to connect.</li>
            <li>Your résumé is in private storage; authorised viewers receive a link that expires after two minutes.</li>
            <li>Organisers see your name, role, organisation, industry and registration status — never contact details, résumés, connection requests or your private follow-up choices.</li>
            <li>Your follow-up decision after meeting your match is never shown to them unless it's mutual.</li>
          </ul>
        </Section>
        <Section title="Your controls">Change visibility and contact sharing at any time, withdraw from an event (your match is simply told you can't make it), block or report anyone, and permanently delete your account and files from Settings.</Section>
        <Section title="Retention">
          Events are archived {r?.archive_events_after_days ?? 30} days after recommendations are released. Résumés are deleted {r?.delete_resumes_after_days ?? 180} days after upload. Notifications are deleted after {r?.delete_notifications_after_days ?? 180} days. These rules are configured by the platform administrator.
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2 className="mb-1 text-lg font-semibold text-navy-900">{title}</h2><div>{children}</div></section>;
}
