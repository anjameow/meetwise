// Display helpers. The server clock is authoritative; the client only uses the
// offset between server_now and its own clock to render countdowns.

export function formatInTz(iso: string | null | undefined, tz: string, opts: Intl.DateTimeFormatOptions = {}) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", ...opts,
  }).format(new Date(iso));
}

export function tzAbbrev(tz: string, at: Date = new Date()) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(at).find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

/** ISO instant -> "YYYY-MM-DDTHH:mm" wall-clock in tz (for datetime-local inputs). */
export function toLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function serverOffset(serverNow: string | null | undefined) {
  return serverNow ? new Date(serverNow).getTime() - Date.now() : 0;
}

export function remaining(targetIso: string | null | undefined, offsetMs: number) {
  if (!targetIso) return null;
  const ms = new Date(targetIso).getTime() - (Date.now() + offsetMs);
  const s = Math.max(0, Math.floor(ms / 1000));
  return { ms, days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}

export function relativeTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
