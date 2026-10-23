import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Clock, HeartHandshake, QrCode, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { useAuth } from "@/hooks/useAuth";

export default function Landing() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [code, setCode] = React.useState("");
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const slug = code.trim().split("/e/").pop()?.split(/[/?#]/)[0]?.toLowerCase();
    if (slug) nav(`/e/${slug}`);
  };
  return (
    <div>
      <section className="relative overflow-hidden bg-navy-900 text-cream-50">
        <div aria-hidden className="absolute inset-0 [background:radial-gradient(70%_60%_at_85%_10%,rgba(212,168,75,.35),transparent_60%),radial-gradient(50%_50%_at_0%_100%,rgba(88,104,160,.5),transparent_60%)]" />
        <div className="container relative max-w-5xl py-16 md:py-24">
          <p className="eyebrow text-gold-300">Professional matchmaking for in-person events</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.05] md:text-6xl">
            Meet <em className="text-gold-300">one</em> genuinely relevant person at every event.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-navy-100">
            Scan the event QR, share what you're looking for, and at the reveal we'll introduce you to the one attendee you
            should really talk to. Afterwards, discover five more.
          </p>
          <form onSubmit={go} className="mt-8 flex max-w-md flex-col gap-2 sm:flex-row">
            <label htmlFor="code" className="sr-only">Event link or code</label>
            <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste an event link or code"
              className="border-white/20 bg-white/10 text-cream-50 placeholder:text-navy-200" />
            <Button type="submit" variant="gold" size="md" className="h-12">Find event <ArrowRight className="h-4 w-4" /></Button>
          </form>
          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            {user ? (
              <Button asChild variant="outline" className="border-white/30 bg-transparent text-cream-50 hover:bg-white/10"><Link to="/events">My events</Link></Button>
            ) : (
              <Button asChild variant="outline" className="border-white/30 bg-transparent text-cream-50 hover:bg-white/10"><Link to="/auth">Sign in</Link></Button>
            )}
            <Button asChild variant="link" className="text-navy-100"><Link to="/organiser/apply">Host an event →</Link></Button>
          </div>
        </div>
      </section>

      <section className="container max-w-5xl py-14">
        <div className="grid gap-4 md:grid-cols-4">
          {[
            { icon: QrCode, t: "Scan & join", d: "Open the event link or QR and create a short profile." },
            { icon: Clock, t: "Wait for the reveal", d: "A live countdown shows when your match appears." },
            { icon: HeartHandshake, t: "Meet your match", d: "One person, with an honest reason why — and an opener." },
            { icon: Sparkles, t: "Five more after", d: "Post-event, discover five more people worth knowing." },
          ].map((s, i) => (
            <div key={s.t} className="card p-5 animate-reveal-up" style={{ animationDelay: `${i * 80}ms` }}>
              <s.icon className="h-6 w-6 text-gold-500" aria-hidden />
              <h2 className="mt-3 text-lg font-semibold">{s.t}</h2>
              <p className="mt-1 text-sm text-navy-500">{s.d}</p>
            </div>
          ))}
        </div>
        <div className="mt-10 flex items-start gap-3 rounded-2xl bg-white p-5 ring-1 ring-navy-100">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-navy-700" aria-hidden />
          <p className="text-sm text-navy-600">
            You choose what your match can see. Contact details and résumés are never public, connections are always mutual,
            and we never use sensitive personal characteristics for matching. <Link to="/privacy" className="font-semibold underline">Privacy notice</Link>
          </p>
        </div>
      </section>
    </div>
  );
}
