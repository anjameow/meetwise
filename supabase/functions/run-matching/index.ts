// Organiser-triggered matching: preview (no writes), launch, or a
// supplemental round for late arrivals. Authorisation is checked with the
// caller's JWT; the job itself runs with the service role.
import { previewMatching, runMatchingJob } from "../_shared/engine.ts";
import { errorResponse, handleOptions, json, requireOrganiser, rpcOf, serviceClient } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const body = await req.json();
    const eventId = String(body.event_id ?? "");
    const mode = body.mode === "supplemental" ? "supplemental" : "primary";
    if (!/^[0-9a-f-]{36}$/.test(eventId)) return json({ error: "invalid_input:event_id" }, 400);

    const user = await requireOrganiser(req, eventId);
    const rpc = rpcOf(serviceClient());

    if (body.action === "preview") {
      return json(await previewMatching(rpc, eventId, mode));
    }
    const result = await runMatchingJob(rpc, {
      eventId,
      mode,
      actor: user.id,
      confirmRerun: body.confirm_rerun === true,
      idempotencyKey: typeof body.idempotency_key === "string" ? body.idempotency_key.slice(0, 100) : null,
    });
    // Advance lifecycle state immediately (e.g. reveal if already due).
    await rpc("service_scheduler_tick", {});
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
});
