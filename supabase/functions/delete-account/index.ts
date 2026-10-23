// Permanently deletes the caller's account: withdraws them from events (so
// matches are handled like a normal withdrawal), removes their files from
// Storage, then deletes the auth user, which cascades to all personal rows.
import { errorResponse, handleOptions, json, requireUser, rpcOf, serviceClient } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== "DELETE") return json({ error: "confirmation_required" }, 409);
    const { user } = await requireUser(req);
    const svc = serviceClient();

    await rpcOf(svc)("service_prepare_account_deletion", { p_user: user.id });
    for (const bucket of ["resumes", "avatars"]) {
      const { data: files } = await svc.storage.from(bucket).list(user.id, { limit: 1000 });
      if (files?.length) await svc.storage.from(bucket).remove(files.map((f) => `${user.id}/${f.name}`));
    }
    const { error } = await svc.auth.admin.deleteUser(user.id);
    if (error) throw error;
    return json({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
});
