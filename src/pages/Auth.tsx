import * as React from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { z } from "zod";
import { Mail } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { ErrorNote, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters"),
  name: z.string().trim().max(80).optional(),
});

function safeNext(next: string | null) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/events";
}

export default function AuthPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [mode, setMode] = React.useState<"signin" | "signup">(params.get("mode") === "signup" ? "signup" : "signin");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  if (user) return <Navigate to={next} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = schema.safeParse({ email, password, name: name || undefined });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: name.trim() }, emailRedirectTo: `${location.origin}${next}` },
        });
        if (error) throw error;
        if (!data.session) setSent(true); else toast.success("Welcome to Meetwise!");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err: any) {
      setError(err?.message ?? "Couldn't sign you in.");
    } finally { setBusy(false); }
  };

  const magic = async () => {
    if (!z.string().email().safeParse(email).success) return setError("Enter your email first");
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}${next}` } });
    setBusy(false);
    if (error) setError(error.message); else setSent(true);
  };

  if (sent) {
    return (
      <div className="page text-center">
        <div className="card mx-auto max-w-md p-8">
          <Mail className="mx-auto h-10 w-10 text-gold-500" aria-hidden />
          <h1 className="mt-4 text-2xl font-semibold">Check your inbox</h1>
          <p className="mt-2 text-navy-500">We sent a link to <strong>{email}</strong>. Open it on this device to continue.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="mx-auto max-w-md">
        <h1 className="text-3xl font-semibold">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
        <p className="mt-1 text-navy-500">One account for every Meetwise event.</p>
        <Tabs value={mode} onValueChange={(v) => setMode(v as any)} className="mt-6">
          <TabsList><TabsTrigger value="signin">Sign in</TabsTrigger><TabsTrigger value="signup">Create account</TabsTrigger></TabsList>
          <TabsContent value={mode}>
            <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
              {mode === "signup" && (
                <Field label="Your name" htmlFor="name"><Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
              )}
              <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              <Field label="Password" htmlFor="password" hint={mode === "signup" ? "At least 8 characters" : undefined}>
                <Input id="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              {error && <ErrorNote>{error}</ErrorNote>}
              <Button type="submit" className="w-full" size="lg" loading={busy}>{mode === "signup" ? "Create account" : "Sign in"}</Button>
              <Button type="button" variant="outline" className="w-full" onClick={magic} disabled={busy}>Email me a sign-in link instead</Button>
              {mode === "signup" && (
                <p className="text-center text-xs text-navy-400">By creating an account you agree to our <Link to="/privacy" className="underline">privacy notice</Link>.</p>
              )}
            </form>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
