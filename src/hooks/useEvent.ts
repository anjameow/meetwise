import { useQuery } from "@tanstack/react-query";
import { rpc } from "@/lib/api";

export interface PublicEvent {
  id: string; slug: string; name: string; tagline: string | null; description: string | null;
  venue_name: string | null; venue_address: string | null; timezone: string; accent_color: string | null;
  starts_at: string | null; ends_at: string | null; registration_opens_at: string | null; registration_deadline: string | null;
  primary_reveal_at: string | null; post_event_reveal_at: string | null; status: string; is_paused: boolean;
  requires_access_code: boolean; allow_late_registration: boolean; is_full?: boolean;
}

export interface PublicEventResponse {
  event: PublicEvent;
  registration_window: "not_open" | "open" | "late" | "closed" | "paused";
  server_now: string;
  is_organiser: boolean;
  registration: null | { status: string; matching_consent: boolean; recommendations_opt_in: boolean; is_late: boolean; registered_at: string };
}

export function useEventBySlug(slug: string | undefined) {
  return useQuery({
    queryKey: ["event_public", slug],
    enabled: !!slug,
    queryFn: () => rpc<PublicEventResponse>("get_event_public", { p_slug: slug }),
  });
}
