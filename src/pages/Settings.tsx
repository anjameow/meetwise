import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, LogOut, Shield, Trash2, UserRound } from "lucide-react";
import { invoke, rpc } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, ConfirmDialog } from "@/components/ui/misc";

export default function SettingsPage() {
  const { user, signOut, isOrganiser } = useAuth();
  const nav = useNavigate();
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: () => rpc<Array<{ user_id: string; full_name: string | null; blocked_at: string }>>("my_blocks") });
  const [delOpen, setDelOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const deleteAccount = async () => {
    setBusy(true);
    try {
      await invoke("delete-account", { confirm: "DELETE" });
      await signOut();
      toast.success("Your account and data have been deleted.");
      nav("/");
    } catch (e) { toast.error(friendlyError(e)); } finally { setBusy(false); }
  };

  return (
    <div className="page space-y-5">
      <h1 className="text-3xl font-semibold">Settings</h1>
      <p className="text-sm text-navy-500">Signed in as {user?.email}</p>

      <Card className="divide-y divide-navy-100">
        <LinkRow to="/profile" icon={UserRound} label="Edit profile, contact details & privacy" />
        <LinkRow to="/privacy" icon={Shield} label="Privacy notice" />
        {!isOrganiser && <LinkRow to="/organiser/apply" icon={Shield} label="Host events on Meetwise" />}
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-semibold">Blocked people</h2>
        {!blocks.data?.length ? <p className="mt-1 text-sm text-navy-500">You haven't blocked anyone.</p> : (
          <ul className="mt-3 divide-y divide-navy-100">
            {blocks.data.map((b) => (
              <li key={b.user_id} className="flex items-center justify-between py-2 text-sm">
                <span>{b.full_name ?? "Former member"}</span>
                <Button size="sm" variant="ghost" onClick={async () => { await rpc("unblock_user", { p_user: b.user_id }); blocks.refetch(); }}>Unblock</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Button variant="outline" className="w-full" onClick={async () => { await signOut(); nav("/"); }}><LogOut className="h-4 w-4" />Sign out</Button>

      <Card className="border-red-200 p-5">
        <h2 className="text-lg font-semibold text-red-800">Delete account</h2>
        <p className="mt-1 text-sm text-navy-600">Permanently deletes your profile, contact details, résumé, photos, registrations, matches, connections and requests. Anyone you're matched with is simply told you can't make it.</p>
        <Button variant="danger" className="mt-4" onClick={() => setDelOpen(true)}><Trash2 className="h-4 w-4" />Delete my account</Button>
      </Card>
      <ConfirmDialog open={delOpen} onOpenChange={setDelOpen} title="Delete your account permanently?" danger loading={busy}
        description="This can't be undone." requireText="DELETE" confirmLabel="Delete everything" onConfirm={deleteAccount} />
    </div>
  );
}

function LinkRow({ to, icon: Icon, label }: { to: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 px-5 py-4 hover:bg-cream-50">
      <Icon className="h-5 w-5 text-navy-500" /><span className="flex-1 font-medium">{label}</span><ChevronRight className="h-4 w-4 text-navy-300" />
    </Link>
  );
}
