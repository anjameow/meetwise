import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { EventForm } from "@/components/EventForm";

export default function EventEditor() {
  const nav = useNavigate();
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="page">
      <p className="eyebrow">New event</p>
      <h1 className="mb-6 mt-1 text-3xl font-semibold">Create an event</h1>
      <EventForm submitLabel="Create draft" busy={busy} onSubmit={async (p) => {
        setBusy(true);
        try {
          const r = await rpc<{ id: string }>("create_event", { p });
          toast.success("Draft created. Publish it when you're ready.");
          nav(`/organiser/events/${r.id}`);
        } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
      }} />
    </div>
  );
}
