import * as React from "react";
import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Hourglass } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { EmptyState, Spinner } from "@/components/ui/misc";

export default function OrganiserApply() {
  const { isOrganiser, user } = useAuth();
  const apps = useQuery({
    queryKey: ["my_applications", user?.id],
    queryFn: async () => (await supabase.from("organiser_applications").select("*").order("created_at", { ascending: false })).data ?? [],
  });
  const [org, setOrg] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (isOrganiser) return <Navigate to="/organiser" replace />;
  if (apps.isLoading) return <Spinner />;
  const pending = apps.data?.find((a: any) => a.status === "pending");
  const rejected = apps.data?.find((a: any) => a.status === "rejected");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await rpc<string>("request_organiser_access", { p_organisation: org, p_reason: reason });
      if (r === "approved") { toast.success("You're approved! Reloading…"); setTimeout(() => location.assign("/organiser"), 800); }
      else { toast.success("Request sent. We'll notify you."); apps.refetch(); }
    } catch (err) { toast.error(friendlyError(err)); } finally { setBusy(false); }
  };

  if (pending) return <div className="page"><EmptyState icon={<Hourglass className="h-6 w-6" />} title="Request under review">A platform administrator will review your request for {pending.organisation}. You'll get a notification.</EmptyState></div>;

  return (
    <div className="page">
      <p className="eyebrow">For organisers</p>
      <h1 className="mt-1 text-3xl font-semibold">Host events on Meetwise</h1>
      <p className="mt-2 text-navy-500">Organiser access is granted by the platform team to keep events safe.</p>
      {rejected?.decision_note && <p className="mt-3 rounded-xl bg-white p-4 text-sm ring-1 ring-navy-100">Last decision: {rejected.decision_note}</p>}
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Organisation or community" htmlFor="org"><Input id="org" required minLength={2} maxLength={120} value={org} onChange={(e) => setOrg(e.target.value)} /></Field>
        <Field label="What events will you run?" htmlFor="why" hint="At least 10 characters"><Textarea id="why" required minLength={10} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button type="submit" loading={busy} disabled={org.trim().length < 2 || reason.trim().length < 10}>Request access</Button>
      </form>
    </div>
  );
}
