import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Flag, ShieldOff } from "lucide-react";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { REPORT_CATEGORIES } from "@/lib/options";
import { Button } from "./ui/button";
import { Field, Select, Textarea } from "./ui/form";
import { ConfirmDialog, Dialog, DialogContent } from "./ui/misc";

export function SafetyActions({ userId, name, eventId, onBlocked }: { userId: string; name: string; eventId?: string; onBlocked?: () => void }) {
  const qc = useQueryClient();
  const [blockOpen, setBlockOpen] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [category, setCategory] = React.useState("");
  const [details, setDetails] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const block = async () => {
    setBusy(true);
    try {
      await rpc("block_user", { p_user: userId });
      toast.success(`${name} is blocked. They won't be told.`);
      qc.invalidateQueries();
      onBlocked?.();
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); setBlockOpen(false); }
  };
  const report = async () => {
    if (!category) return;
    setBusy(true);
    try {
      await rpc("report_user", { p_user: userId, p_category: category, p_details: details || null, p_event: eventId ?? null });
      toast.success("Thanks — our team will review this privately.");
      setReportOpen(false); setCategory(""); setDetails("");
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  };

  return (
    <div className="flex gap-1">
      <Button variant="ghost" size="sm" onClick={() => setReportOpen(true)}><Flag className="h-4 w-4" />Report</Button>
      <Button variant="ghost" size="sm" onClick={() => setBlockOpen(true)}><ShieldOff className="h-4 w-4" />Block</Button>
      <ConfirmDialog open={blockOpen} onOpenChange={setBlockOpen} title={`Block ${name}?`} danger loading={busy} confirmLabel="Block"
        description="You won't be matched, recommended or able to contact each other. Any match or connection between you ends. They aren't notified."
        onConfirm={block} />
      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent title={`Report ${name}`} description="Reports are confidential and reviewed by the Meetwise team.">
          <div className="space-y-4">
            <Field label="What happened?" htmlFor="rep-cat"><Select id="rep-cat" options={REPORT_CATEGORIES} value={category} onValueChange={setCategory} /></Field>
            <Field label="Details" htmlFor="rep-det" optional><Textarea id="rep-det" maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
            <Button className="w-full" onClick={report} loading={busy} disabled={!category}>Send report</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
