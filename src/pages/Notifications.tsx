import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { rpc } from "@/lib/api";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState, Spinner } from "@/components/ui/misc";

interface Note { id: string; type: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }

export default function Notifications() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => {
      const { data, error } = await supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return data as Note[];
    },
  });
  const markAll = async () => { await rpc("mark_all_notifications_read"); q.refetch(); qc.invalidateQueries({ queryKey: ["unread"] }); };
  const markOne = async (id: string) => { await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", id); qc.invalidateQueries({ queryKey: ["unread"] }); };

  return (
    <div className="page">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Inbox</h1>
        {!!q.data?.some((n) => !n.read_at) && <Button variant="ghost" size="sm" onClick={markAll}>Mark all read</Button>}
      </div>
      <div className="mt-5">
        {q.isLoading ? <Spinner /> : !q.data?.length ? (
          <EmptyState icon={<Bell className="h-6 w-6" />} title="All quiet">Match reveals, connection requests and event updates will show up here.</EmptyState>
        ) : (
          <ul className="card divide-y divide-navy-100">
            {q.data.map((n) => {
              const inner = (
                <div className="flex gap-3 px-5 py-4">
                  <span className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-gold-400")} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={cn("font-semibold", n.read_at && "font-medium text-navy-600")}>{n.title}</p>
                    {n.body && <p className="text-sm text-navy-500">{n.body}</p>}
                    <p className="mt-1 text-xs text-navy-400">{relativeTime(n.created_at)}{!n.read_at && <span className="sr-only"> · unread</span>}</p>
                  </div>
                </div>
              );
              return <li key={n.id}>{n.link ? <Link to={n.link} onClick={() => markOne(n.id)} className="block hover:bg-cream-50">{inner}</Link> : inner}</li>;
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
