import * as React from "react";
import { remaining, serverOffset } from "@/lib/time";

/**
 * Informational countdown. Uses the server's clock offset; when it reaches
 * zero it calls onElapsed so the page can re-ask the server (which decides).
 */
export function Countdown({ target, serverNow, onElapsed, label }: {
  target: string | null | undefined; serverNow: string | null | undefined; onElapsed?: () => void; label: string;
}) {
  const offset = React.useMemo(() => serverOffset(serverNow), [serverNow]);
  const [, tick] = React.useState(0);
  const fired = React.useRef(false);
  React.useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const r = remaining(target, offset);
  React.useEffect(() => {
    if (r && r.ms <= 0 && !fired.current) { fired.current = true; setTimeout(() => onElapsed?.(), 1200); }
    if (r && r.ms > 0) fired.current = false;
  });
  if (!r) return null;
  const units: Array<[number, string]> = r.days > 0
    ? [[r.days, "days"], [r.hours, "hrs"], [r.minutes, "min"]]
    : [[r.hours, "hrs"], [r.minutes, "min"], [r.seconds, "sec"]];
  return (
    <div role="timer" aria-label={label} aria-live="off" className="flex justify-center gap-3">
      {units.map(([v, u]) => (
        <div key={u} className="w-20 rounded-2xl bg-white/10 px-2 py-3 text-center ring-1 ring-white/15 backdrop-blur">
          <div className="font-display text-4xl font-semibold tabular-nums text-cream-50">{String(v).padStart(2, "0")}</div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-gold-300">{u}</div>
        </div>
      ))}
    </div>
  );
}
