import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { REPORT_CATEGORIES, STATUS_LABELS, WEIGHT_LABELS, labelOf } from "@/lib/options";
import { relativeTime } from "@/lib/time";
import { EventStatusBadge } from "@/components/EventHeader";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Badge, Card, ConfirmDialog, EmptyState, Spinner, Stat, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";

export default function AdminPage() {
  const overview = useQuery({ queryKey: ["admin_overview"], queryFn: () => rpc<any>("admin_overview") });
  return (
    <div className="page-wide">
      <p className="eyebrow">Platform</p>
      <h1 className="mt-1 text-3xl font-semibold">Administration</h1>
      <Tabs defaultValue="overview" className="mt-5">
        <TabsList>
          {["overview", "applications", "reports", "users", "events", "settings", "audit"].map((t) => <TabsTrigger key={t} value={t} className="capitalize">{t}</TabsTrigger>)}
        </TabsList>
        <div className="mt-5">
          <TabsContent value="overview">
            {overview.isLoading ? <Spinner /> : overview.data && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Members" value={overview.data.users} />
                <Stat label="Organisers" value={overview.data.organisers} />
                <Stat label="Open reports" value={overview.data.open_reports} />
                <Stat label="Pending applications" value={overview.data.pending_applications} />
                {Object.entries(overview.data.events ?? {}).map(([s, n]) => <Stat key={s} label={STATUS_LABELS[s] ?? s} value={n as number} hint="events" />)}
              </div>
            )}
          </TabsContent>
          <TabsContent value="applications"><Applications /></TabsContent>
          <TabsContent value="reports"><Reports /></TabsContent>
          <TabsContent value="users"><Users /></TabsContent>
          <TabsContent value="events"><Events /></TabsContent>
          <TabsContent value="settings">{overview.data && <PlatformSettings settings={overview.data.settings} onSaved={() => overview.refetch()} />}</TabsContent>
          <TabsContent value="audit"><Audit /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function Applications() {
  const q = useQuery({ queryKey: ["admin_apps"], queryFn: () => rpc<any[]>("admin_list_applications", { p_status: "pending" }) });
  const decide = async (id: string, approve: boolean) => {
    try { await rpc("admin_decide_application", { p_application: id, p_approve: approve, p_note: null }); toast.success(approve ? "Approved" : "Declined"); q.refetch(); }
    catch (e) { toast.error(friendlyError(e)); }
  };
  if (q.isLoading) return <Spinner />;
  if (!q.data?.length) return <EmptyState title="No pending applications" />;
  return (
    <div className="space-y-3">
      {q.data.map((a) => (
        <Card key={a.id} className="p-5">
          <div className="flex flex-wrap justify-between gap-2"><div><p className="font-semibold">{a.full_name ?? a.email} · {a.organisation}</p><p className="text-sm text-navy-500">{a.email} · {relativeTime(a.created_at)}</p></div>
            <div className="flex gap-2"><Button size="sm" variant="gold" onClick={() => decide(a.id, true)}>Approve</Button><Button size="sm" variant="outline" onClick={() => decide(a.id, false)}>Decline</Button></div></div>
          <p className="mt-2 text-sm text-navy-700">{a.reason}</p>
        </Card>
      ))}
    </div>
  );
}

function Reports() {
  const [status, setStatus] = React.useState("open");
  const q = useQuery({ queryKey: ["admin_reports", status], queryFn: () => rpc<any[]>("admin_list_reports", { p_status: status || null }) });
  const [suspend, setSuspend] = React.useState<any | null>(null);
  const [note, setNote] = React.useState("");
  const resolve = async (id: string, s: string) => {
    try { await rpc("admin_resolve_report", { p_report: id, p_status: s, p_note: note || null }); setNote(""); q.refetch(); }
    catch (e) { toast.error(friendlyError(e)); }
  };
  return (
    <div className="space-y-3">
      <Select aria-label="Status" className="w-48" value={status} onValueChange={setStatus} placeholder="All"
        options={[{ value: "open", label: "Open" }, { value: "reviewing", label: "Reviewing" }, { value: "resolved", label: "Resolved" }, { value: "dismissed", label: "Dismissed" }]} />
      {q.isLoading ? <Spinner /> : !q.data?.length ? <EmptyState title="Nothing to review" /> : q.data.map((r) => (
        <Card key={r.id} className="space-y-2 p-5">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="red">{labelOf(REPORT_CATEGORIES, r.category)}</Badge><Badge>{r.status}</Badge><span className="text-sm text-navy-400">{relativeTime(r.created_at)}{r.event_name ? ` · ${r.event_name}` : ""}</span></div>
          <p className="text-sm"><strong>{r.reporter.full_name ?? "Deleted user"}</strong> reported <strong>{r.reported.full_name ?? "deleted user"}</strong>{r.reported.suspended ? " (suspended)" : ""}</p>
          {r.details && <p className="rounded-xl bg-cream-100 p-3 text-sm">{r.details}</p>}
          {r.resolution_note && <p className="text-sm text-navy-500">Note: {r.resolution_note}</p>}
          {["open", "reviewing"].includes(r.status) && (
            <>
              <Textarea aria-label="Resolution note" placeholder="Resolution note (internal)" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[60px]" />
              <div className="flex flex-wrap gap-2">
                {r.status === "open" && <Button size="sm" variant="outline" onClick={() => resolve(r.id, "reviewing")}>Mark reviewing</Button>}
                <Button size="sm" onClick={() => resolve(r.id, "resolved")}>Resolve</Button>
                <Button size="sm" variant="ghost" onClick={() => resolve(r.id, "dismissed")}>Dismiss</Button>
                {r.reported.id && !r.reported.suspended && <Button size="sm" variant="danger" onClick={() => setSuspend(r.reported)}>Suspend user</Button>}
              </div>
            </>
          )}
        </Card>
      ))}
      {suspend && <SuspendDialog user={suspend} onDone={() => { setSuspend(null); q.refetch(); }} />}
    </div>
  );
}

function SuspendDialog({ user, onDone }: { user: { id: string; full_name: string | null }; onDone: () => void }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onDone()} danger loading={busy} title={`Suspend ${user.full_name ?? "this user"}?`}
      description="They're removed from active matches, recommendations and pending requests, and can't register for events."
      confirmLabel="Suspend" onConfirm={async () => {
        setBusy(true);
        try { await rpc("admin_set_suspension", { p_user: user.id, p_suspend: true, p_reason: "Moderation" }); toast.success("Suspended"); }
        catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); onDone(); }
      }} />
  );
}

function Users() {
  const [query, setQuery] = React.useState("");
  const [submitted, setSubmitted] = React.useState("");
  const q = useQuery({ queryKey: ["admin_users", submitted], queryFn: () => rpc<any[]>("admin_search_users", { p_query: submitted }) });
  const setRole = async (id: string, role: string, grant: boolean) => {
    try { await rpc("admin_set_role", { p_user: id, p_role: role, p_grant: grant }); q.refetch(); } catch (e) { toast.error(friendlyError(e)); }
  };
  const unsuspend = async (id: string) => {
    try { await rpc("admin_set_suspension", { p_user: id, p_suspend: false, p_reason: null }); q.refetch(); } catch (e) { toast.error(friendlyError(e)); }
  };
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); setSubmitted(query); }} className="relative">
        <Search className="absolute left-3.5 top-3.5 h-5 w-5 text-navy-300" aria-hidden />
        <Input aria-label="Search users" className="pl-11" placeholder="Search by email or name, then Enter" value={query} onChange={(e) => setQuery(e.target.value)} />
      </form>
      {q.isLoading ? <Spinner /> : (
        <Card className="divide-y divide-navy-100">
          {q.data?.map((u) => {
            const isOrg = u.roles.includes("organiser"); const isAdmin = u.roles.includes("admin");
            return (
              <div key={u.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1"><p className="font-semibold">{u.full_name ?? "—"}</p><p className="text-sm text-navy-500">{u.email}</p>
                  <div className="mt-1 flex gap-1.5">{isAdmin && <Badge tone="navy">Admin</Badge>}{isOrg && <Badge tone="gold">Organiser</Badge>}{u.suspended && <Badge tone="red">Suspended</Badge>}{u.open_reports > 0 && <Badge tone="red">{u.open_reports} reports</Badge>}</div></div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setRole(u.id, "organiser", !isOrg)}>{isOrg ? "Revoke organiser" : "Make organiser"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRole(u.id, "admin", !isAdmin)}>{isAdmin ? "Revoke admin" : "Make admin"}</Button>
                  {u.suspended && <Button size="sm" variant="ghost" onClick={() => unsuspend(u.id)}>Unsuspend</Button>}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function Events() {
  const q = useQuery({ queryKey: ["admin_events"], queryFn: () => rpc<any[]>("admin_list_events") });
  if (q.isLoading) return <Spinner />;
  return (
    <Card className="divide-y divide-navy-100">
      {q.data?.map((e) => (
        <Link key={e.id} to={`/organiser/events/${e.id}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-cream-50">
          <span><strong>{e.name}</strong> <span className="text-sm text-navy-500">· {e.owner ?? "—"} · {e.registered} registered</span></span>
          <EventStatusBadge status={e.status} paused={e.is_paused} />
        </Link>
      ))}
    </Card>
  );
}

function PlatformSettings({ settings, onSaved }: { settings: Record<string, any>; onSaved: () => void }) {
  const [weights, setWeights] = React.useState<Record<string, number>>(settings.default_matching_weights);
  const [rules, setRules] = React.useState<Record<string, any>>(settings.default_role_rules);
  const [retention, setRetention] = React.useState<Record<string, number>>(settings.retention);
  const [auto, setAuto] = React.useState<boolean>(settings.organiser_auto_approve === true);
  const save = async (key: string, value: unknown) => {
    try { await rpc("admin_update_setting", { p_key: key, p_value: value }); toast.success("Saved"); onSaved(); } catch (e) { toast.error(friendlyError(e)); }
  };
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="space-y-3 p-5">
        <h3 className="font-semibold">Default matching weights (new events)</h3>
        {Object.keys(WEIGHT_LABELS).map((k) => (
          <Field key={k} label={WEIGHT_LABELS[k]} htmlFor={`dw-${k}`}><Input id={`dw-${k}`} type="number" min={0} max={100} value={weights[k] ?? 0} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} /></Field>
        ))}
        <Button size="sm" onClick={() => save("default_matching_weights", weights)}>Save weights</Button>
      </Card>
      <div className="space-y-5">
        <Card className="p-5">
          <h3 className="font-semibold">Default rules</h3>
          <Switch checked={!!rules.exclude_same_organisation} onChange={(v) => setRules({ ...rules, exclude_same_organisation: v })} label="Don't match colleagues" />
          <Switch checked={!!rules.auto_match_late_arrivals} onChange={(v) => setRules({ ...rules, auto_match_late_arrivals: v })} label="Auto-match late arrivals" />
          <Field label="Minimum match score" htmlFor="dmin"><Input id="dmin" type="number" min={0} max={90} value={rules.min_score} onChange={(e) => setRules({ ...rules, min_score: Number(e.target.value) })} /></Field>
          <Button size="sm" className="mt-3" onClick={() => save("default_role_rules", rules)}>Save rules</Button>
        </Card>
        <Card className="space-y-3 p-5">
          <h3 className="font-semibold">Data retention (days)</h3>
          {[["archive_events_after_days", "Archive events after recommendations"], ["delete_resumes_after_days", "Delete résumés after upload"], ["delete_notifications_after_days", "Delete notifications"], ["delete_audit_after_days", "Delete audit logs"]].map(([k, l]) => (
            <Field key={k} label={l} htmlFor={`r-${k}`}><Input id={`r-${k}`} type="number" min={1} value={retention[k] ?? ""} onChange={(e) => setRetention({ ...retention, [k]: Number(e.target.value) })} /></Field>
          ))}
          <Button size="sm" onClick={() => save("retention", retention)}>Save retention</Button>
        </Card>
        <Card className="p-5">
          <Switch checked={auto} onChange={(v) => { setAuto(v); void save("organiser_auto_approve", v); }} label="Auto-approve organiser requests" description="Off is recommended: review who can host events." />
        </Card>
      </div>
    </div>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ["admin_audit"], queryFn: () => rpc<any[]>("admin_audit_log") });
  if (q.isLoading) return <Spinner />;
  return (
    <Card className="divide-y divide-navy-100">
      {q.data?.map((l) => (
        <div key={l.id} className="flex flex-wrap justify-between gap-2 px-5 py-2.5 text-sm"><span><strong>{l.action}</strong> · {l.actor ?? "system"}{l.target_type ? ` · ${l.target_type}` : ""}</span><span className="text-navy-400">{relativeTime(l.created_at)}</span></div>
      ))}
    </Card>
  );
}
