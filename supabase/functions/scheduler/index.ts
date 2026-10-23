// Scheduled entry point (called every minute by pg_cron via pg_net, or by any
// external cron). Runs the lifecycle tick, due matching/recommendation jobs and
// resume retention. Only callers holding the service-role key (or the optional
// CRON_SECRET) may invoke it.
import { runSchedulerPass } from "../_shared/engine.ts";
import { errorResponse, json, rpcOf, serviceClient } from "../_shared/http.ts";

function authorised(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cron = Deno.env.get("CRON_SECRET");
  return !!token && (token === service || (!!cron && token === cron));
}

Deno.serve(async (req) => {
  if (!authorised(req)) return json({ error: "forbidden" }, 403);
  try {
    const svc = serviceClient();
    const rpc = rpcOf(svc);
    const pass = await runSchedulerPass(rpc);

    // Resume retention: remove the file via the Storage API, then the row.
    const expired: Array<{ user_id: string; storage_path: string }> = await rpc("service_expired_resumes", {});
    let removed = 0;
    for (const r of expired.slice(0, 100)) {
      const { error } = await svc.storage.from("resumes").remove([r.storage_path]);
      if (!error) {
        await rpc("service_delete_resume_row", { p_user: r.user_id, p_path: r.storage_path });
        removed++;
      }
    }
    return json({ ...pass, resumes_removed: removed });
  } catch (err) {
    return errorResponse(err);
  }
});
