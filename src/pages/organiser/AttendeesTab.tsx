import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { INDUSTRIES, labelOf } from "@/lib/options";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { Badge, Card, ConfirmDialog, EmptyState, Spinner } from "@/components/ui/misc";

interface Attendee {
  user_id: string; full_name: string | null; job_title: string | null; organisation: string | null; industry: string | null; status: string;
  matching_consent: boolean; recommendations_opt_in: boolean; profile_complete: boolean; suspended: boolean; is_late: boolean;
  registered_at: string; checked_in_at: string | null; awaiting_match: boolean; matched: boolean;
}

export function AttendeesTab({ eventId }: { eventId: string }) {
  const q = useQuery({ queryKey: ["attendees", eventId], queryFn: () => rpc<Attendee[]>("organiser_event_attendees", { p_event: eventId }) });
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("");
  const [removing, setRemoving] = React.useState<Attendee | null>(null);
  const [busy, setBusy] = React.useState(false);

  const act = async (a: Attendee, action: string) => {
    setBusy(true);
    try {
      await rpc("organiser_manage_registration", { p_event: eventId, p_user: a.user_id, p_action: action, p_reason: null });
      q.refetch();
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); setRemoving(null); }
  };

  if (q.isLoading) return <Spinner />;
  const rows = (q.data ?? []).filter((a) => {
    const s = search.toLowerCase();
    const okSearch = !s || [a.full_name, a.job_title, a.organisation].some((x) => x?.toLowerCase().includes(s));
    const okFilter = !filter
      || (filter === "unmatched" && !a.matched && a.profile_complete && a.matching_consent && ["registered", "checked_in"].includes(a.status))
      || (filter === "incomplete" && !a.profile_complete)
      || (filter === "late" && a.is_late)
      || (filter === "inactive" && !["registered", "checked_in"].includes(a.status));
    return okSearch && okFilter;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-3.5 h-5 w-5 text-navy-300" aria-hidden />
          <Input aria-label="Search attendees" placeholder="Search name, role or organisation" className="pl-11" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select aria-label="Filter" className="sm:w-56" value={filter} onValueChange={setFilter} placeholder="Everyone"
          options={[{ value: "unmatched", label: "Eligible but unmatched" }, { value: "incomplete", label: "Incomplete profiles" }, { value: "late", label: "Late arrivals" }, { value: "inactive", label: "Withdrawn / removed" }]} />
      </div>
      <p className="text-sm text-navy-500">{rows.length} of {q.data?.length ?? 0} · Contact details are never visible to organisers.</p>
      {rows.length === 0 ? <EmptyState title="No attendees here">Share the event link or QR code to get registrations.</EmptyState> : (
        <Card className="divide-y divide-navy-100">
          {rows.map((a) => {
            const active = ["registered", "checked_in"].includes(a.status);
            return (
              <div key={a.user_id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{a.full_name ?? "Unnamed attendee"}</p>
                  <p className="text-sm text-navy-500">{[a.job_title, a.organisation, labelOf(INDUSTRIES, a.industry)].filter(Boolean).join(" · ") || "—"}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Badge tone={active ? "green" : "red"}>{a.status.replace("_", " ")}</Badge>
                    {!a.profile_complete && <Badge tone="gold">Profile incomplete</Badge>}
                    {!a.matching_consent && <Badge>No matching</Badge>}
                    {a.matched && <Badge tone="navy">Matched</Badge>}
                    {a.awaiting_match && <Badge tone="gold">Awaiting match</Badge>}
                    {a.is_late && <Badge>Late</Badge>}
                    {a.suspended && <Badge tone="red">Suspended</Badge>}
                  </div>
                </div>
                <div className="flex gap-2">
                  {a.status === "registered" && <Button size="sm" variant="outline" disabled={busy} onClick={() => act(a, "check_in")}>Check in</Button>}
                  {a.status === "checked_in" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(a, "undo_check_in")}>Undo check-in</Button>}
                  {a.status === "removed" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => act(a, "restore")}>Restore</Button>
                    : active && <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setRemoving(a)}>Remove</Button>}
                </div>
              </div>
            );
          })}
        </Card>
      )}
      <ConfirmDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing?.full_name ?? "attendee"}?`} danger loading={busy}
        description="They'll be taken out of matching and recommendations. If they have a match, the other person is told only that their match can't make it."
        confirmLabel="Remove" onConfirm={() => removing && act(removing, "remove")} />
    </div>
  );
}
