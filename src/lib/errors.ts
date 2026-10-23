// Map server error codes (raised by Postgres functions / edge functions) to
// human messages. Unknown errors fall back to a generic message.
const MESSAGES: Record<string, string> = {
  not_authenticated: "Please sign in to continue.",
  forbidden: "You don't have permission to do that.",
  not_found: "We couldn't find that. It may have been removed or isn't available to you yet.",
  rate_limited: "You're going a little fast. Please wait a moment and try again.",
  registration_closed: "Registration for this event is closed.",
  invalid_access_code: "That access code doesn't match. Check with the organiser.",
  email_domain_not_allowed: "This event is limited to specific email domains.",
  event_full: "This event is full.",
  removed_by_organiser: "The organiser has removed you from this event.",
  account_suspended: "Your account is suspended. Contact support if you think this is a mistake.",
  not_registered: "You're not registered for this event.",
  already_decided: "That decision has already been made.",
  match_unavailable: "This match is no longer available.",
  confirmation_required: "Please confirm this action.",
  invalid_transition: "That action isn't available in the event's current state.",
  registration_still_open: "Matching can start once registration closes.",
  rerun_after_reveal: "Matches are already revealed. Use a late-arrival round instead.",
  event_paused: "This event is paused. Resume it first.",
  primary_round_required: "Run the main matching round first.",
  organiser_not_found: "No organiser account with that email.",
  event_archived: "Archived events can't be edited.",
  "invalid_input:schedule_incomplete": "Fill in every date in the schedule before publishing.",
  "invalid_input:deadline_in_past": "The registration deadline must be in the future.",
  "invalid_input:primary_reveal_after_end": "The match reveal must happen before the event ends.",
  "invalid_input:post_reveal_before_end": "Recommendations must be revealed after the event ends.",
  "invalid_input:primary_already_revealed": "Matches are already revealed, so the reveal time can't change.",
  "invalid_input:recommendations_already_revealed": "Recommendations are already revealed.",
  "invalid_input:timezone": "Choose a valid timezone.",
  "invalid_input:weights_zero": "At least one weight must be above zero.",
  "invalid_input:consent_required": "Please choose your matching preferences.",
};

export class AppError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  const m = (err as { message?: string })?.message ?? String(err);
  return m;
}

export function friendlyError(err: unknown): string {
  const code = errorCode(err);
  if (MESSAGES[code]) return MESSAGES[code];
  const prefix = Object.keys(MESSAGES).find((k) => code.startsWith(k));
  if (prefix) return MESSAGES[prefix];
  if (code.includes("violates check constraint")) return "Some details don't look right. Please check the highlighted fields.";
  if (/Failed to fetch|NetworkError/i.test(code)) return "You seem to be offline. We'll keep your changes and retry.";
  if (code.startsWith("invalid_input")) return "Some details don't look right. Please check and try again.";
  return "Something went wrong. Please try again.";
}
