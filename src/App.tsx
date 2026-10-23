import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AuthProvider } from "@/hooks/useAuth";
import { AppShell, RequireAuth } from "@/components/AppShell";
import Landing from "@/pages/Landing";
import AuthPage from "@/pages/Auth";
import EventEntry from "@/pages/EventEntry";
import JoinEvent from "@/pages/JoinEvent";
import EventHub from "@/pages/EventHub";
import MatchReveal from "@/pages/MatchReveal";
import Discover from "@/pages/Discover";
import Connections from "@/pages/Connections";
import Notifications from "@/pages/Notifications";
import SettingsPage from "@/pages/Settings";
import PrivacyNotice from "@/pages/PrivacyNotice";
import MyEvents from "@/pages/MyEvents";
import NotFound from "@/pages/NotFound";
import { Spinner } from "@/components/ui/misc";

// Heavier screens are code-split.
const ProfileWizard = lazy(() => import("@/pages/ProfileWizard"));
const OrganiserHome = lazy(() => import("@/pages/organiser/OrganiserHome"));
const OrganiserApply = lazy(() => import("@/pages/organiser/OrganiserApply"));
const EventEditor = lazy(() => import("@/pages/organiser/EventEditor"));
const OrganiserEvent = lazy(() => import("@/pages/organiser/OrganiserEvent"));
const AdminPage = lazy(() => import("@/pages/admin/AdminPage"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<Spinner />}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/privacy" element={<PrivacyNotice />} />
              <Route path="/e/:slug" element={<EventEntry />} />
              <Route path="/e/:slug/join" element={<RequireAuth><JoinEvent /></RequireAuth>} />
              <Route path="/e/:slug/hub" element={<RequireAuth><EventHub /></RequireAuth>} />
              <Route path="/e/:slug/match" element={<RequireAuth><MatchReveal /></RequireAuth>} />
              <Route path="/e/:slug/discover" element={<RequireAuth><Discover /></RequireAuth>} />
              <Route path="/events" element={<RequireAuth><MyEvents /></RequireAuth>} />
              <Route path="/profile" element={<RequireAuth><ProfileWizard /></RequireAuth>} />
              <Route path="/connections" element={<RequireAuth><Connections /></RequireAuth>} />
              <Route path="/notifications" element={<RequireAuth><Notifications /></RequireAuth>} />
              <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
              <Route path="/organiser/apply" element={<RequireAuth><OrganiserApply /></RequireAuth>} />
              <Route path="/organiser" element={<RequireAuth role="organiser"><OrganiserHome /></RequireAuth>} />
              <Route path="/organiser/events/new" element={<RequireAuth role="organiser"><EventEditor /></RequireAuth>} />
              <Route path="/organiser/events/:id" element={<RequireAuth role="organiser"><OrganiserEvent /></RequireAuth>} />
              <Route path="/admin" element={<RequireAuth role="admin"><AdminPage /></RequireAuth>} />
              <Route path="/home" element={<Navigate to="/events" replace />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster position="top-center" toastOptions={{ className: "!rounded-2xl !font-sans" }} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
