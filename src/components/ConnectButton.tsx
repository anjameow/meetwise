import * as React from "react";
import { toast } from "sonner";
import { Check, Clock, UserPlus } from "lucide-react";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { Button } from "./ui/button";
import { Field, Textarea } from "./ui/form";
import { Dialog, DialogContent } from "./ui/misc";
import { cn } from "@/lib/utils";

export function ConnectButton({ userId, name, eventId, status, onChange }: {
  userId: string; name: string; eventId?: string | null; status: string | null | undefined; onChange: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<"connect" | "mentee" | "mentor">("connect");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (status === "connected") return <Button variant="outline" size="sm" disabled><Check className="h-4 w-4" />Connected</Button>;
  if (status === "pending") return <Button variant="outline" size="sm" disabled><Clock className="h-4 w-4" />Requested</Button>;

  const send = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>("send_connection_request", {
        p_recipient: userId, p_event: eventId ?? null, p_kind: kind === "connect" ? "connect" : "mentorship",
        p_mentorship_role: kind === "connect" ? null : kind, p_message: message || null,
      });
      toast.success(r.status === "connected" ? `You and ${name} are now connected!` : `Request sent to ${name}`);
      setOpen(false); onChange();
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" />Connect</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Connect with ${name}`} description="They'll see your request and can accept or ignore it. Contact details are only exchanged if they accept.">
          <div className="space-y-4">
            <div role="radiogroup" aria-label="Request type" className="grid gap-2">
              {[
                ["connect", "Professional connection"],
                ["mentee", "Ask about mentorship (they mentor me)"],
                ["mentor", "Offer mentorship (I mentor them)"],
              ].map(([v, l]) => (
                <button key={v} role="radio" aria-checked={kind === v} onClick={() => setKind(v as any)}
                  className={cn("rounded-xl border px-4 py-3 text-left text-sm font-semibold", kind === v ? "border-navy-900 bg-navy-900 text-cream-50" : "border-navy-200 bg-white")}>{l}</button>
              ))}
            </div>
            <Field label="Add a note" htmlFor="note" optional hint={`${message.length}/300`}>
              <Textarea id="note" maxLength={300} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Loved your intro about…" />
            </Field>
            <Button className="w-full" onClick={send} loading={busy}>Send request</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
