// Organiser-triggered (re)generation of post-event recommendations.
// Regenerating after attendees can already see them requires confirmation.
import { runRecommendationJob } from "../_shared/engine.ts";
import { errorResponse, handleOptions, json, requireOrganiser, rpcOf, serviceClient } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const body = await req.json();
    const eventId = String(body.event_id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(eventId)) return json({ error: "invalid_input:event_id" }, 400);
    await requireOrganiser(req, eventId);

    const svc = serviceClient();
    const { data: ev, error } = await svc.from("events")
      .select("post_event_reveal_at, recommendations_generated_at, is_paused").eq("id", eventId).single();
    if (error) throw error;
    const revealed = ev.recommendations_generated_at && new Date(ev.post_event_reveal_at) <= new Date();
    if (revealed && body.confirm !== true) return json({ error: "confirmation_required" }, 409);

    const rpc = rpcOf(svc);
    const result = await runRecommendationJob(rpc, eventId);
    await rpc("service_scheduler_tick", {});
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
});
