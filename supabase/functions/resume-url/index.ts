// Issues a short-lived signed URL for a private resume, only if
// can_view_resume() (evaluated as the caller) allows it. Resume access is
// deliberately separate from profile access.
import { errorResponse, handleOptions, json, requireUser, rpcOf, serviceClient } from "../_shared/http.ts";

const TTL_SECONDS = 120;

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const { owner_id } = await req.json();
    if (!/^[0-9a-f-]{36}$/.test(String(owner_id))) return json({ error: "invalid_input:owner_id" }, 400);
    const { client } = await requireUser(req);
    const allowed = await rpcOf(client)("can_view_resume", { p_owner: owner_id });
    if (allowed !== true) return json({ error: "not_found" }, 404);

    const svc = serviceClient();
    const path: string | null = await rpcOf(svc)("service_resume_path", { p_owner: owner_id });
    if (!path) return json({ error: "not_found" }, 404);
    const { data, error } = await svc.storage.from("resumes").createSignedUrl(path, TTL_SECONDS, { download: false });
    if (error) throw error;
    return json({ url: data.signedUrl, expires_in: TTL_SECONDS });
  } catch (err) {
    return errorResponse(err);
  }
});
