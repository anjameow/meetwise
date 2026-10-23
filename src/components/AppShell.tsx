import * as React from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, CalendarHeart, LayoutDashboard, Settings, Shield, UserRound, Users } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Spinner } from "./ui/misc";

export function Logo({ light }: { light?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label="Meetwise home">
      <svg viewBox="0 0 64 64" className="h-8 w-8" aria-hidden>
        <rect width="64" height="64" rx="16" fill={light ? "#FBF7F0" : "#0E1A3A"} />
        <circle cx="25" cy="32" r="11" fill="none" stroke="#D4A84B" strokeWidth="5" />
        <circle cx="39" cy="32" r="11" fill="none" stroke={light ? "#0E1A3A" : "#FBF7F0"} strokeWidth="5" />
      </svg>
      <span className={cn("font-display text-xl font-semibold", light ? "text-cream-50" : "text-navy-900")}>Meetwise</span>
    </Link>
  );
}

function useUnread() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["unread", user?.id],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
      return count ?? 0;
    },
  });
}

export function AppShell() {
  const { user, isOrganiser, isAdmin } = useAuth();
  const unread = useUnread();
  const nav = [
    { to: "/events", label: "Events", icon: CalendarHeart },
    { to: "/connections", label: "People", icon: Users },
    { to: "/notifications", label: "Inbox", icon: Bell, badge: unread.data },
    { to: "/profile", label: "Profile", icon: UserRound },
  ];
  return (
    <div className="min-h-dvh">
      {!supabaseConfigured && (
        <div className="bg-gold-100 px-4 py-2 text-center text-sm text-navy-800">
          Supabase isn't configured yet — set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in your hosting settings, then redeploy.
        </div>
      )}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-40 border-b border-navy-100/60 bg-cream-100/85 backdrop-blur">
        <div className="container flex h-16 max-w-6xl items-center justify-between">
          <Logo />
          {user && (
            <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
              {nav.map((n) => <TopLink key={n.to} {...n} />)}
              {isOrganiser && <TopLink to="/organiser" label="Organise" icon={LayoutDashboard} />}
              {isAdmin && <TopLink to="/admin" label="Admin" icon={Shield} />}
              <TopLink to="/settings" label="Settings" icon={Settings} />
            </nav>
          )}
          {user ? (
            <Link to="/settings" className="md:hidden" aria-label="Settings"><Settings className="h-5 w-5 text-navy-600" /></Link>
          ) : (
            <Link to="/auth" className="text-sm font-semibold text-navy-800 hover:underline">Sign in</Link>
          )}
        </div>
      </header>
      <main id="main"><Outlet /></main>
      {user && (
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-navy-100 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          <div className="grid grid-cols-5">
            {[...nav, ...(isOrganiser ? [{ to: "/organiser", label: "Organise", icon: LayoutDashboard }] : [{ to: "/settings", label: "Settings", icon: Settings }])].map((n: any) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => cn("relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold", isActive ? "text-navy-900" : "text-navy-400")}>
                <n.icon className="h-5 w-5" aria-hidden />
                {n.label}
                {!!n.badge && <span className="absolute right-[28%] top-1.5 h-2 w-2 rounded-full bg-gold-400" aria-label={`${n.badge} unread`} />}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

function TopLink({ to, label, icon: Icon, badge }: { to: string; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }) {
  return (
    <NavLink to={to} className={({ isActive }) => cn("relative flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold transition", isActive ? "bg-navy-900 text-cream-50" : "text-navy-600 hover:bg-navy-50")}>
      <Icon className="h-4 w-4" />{label}
      {!!badge && <span className="ml-0.5 rounded-full bg-gold-400 px-1.5 text-[10px] text-navy-950">{badge}</span>}
    </NavLink>
  );
}

export function RequireAuth({ children, role }: { children: React.ReactNode; role?: "organiser" | "admin" }) {
  const { user, loading, isOrganiser, isAdmin } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/auth?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (role === "admin" && !isAdmin) return <Navigate to="/events" replace />;
  if (role === "organiser" && !isOrganiser) return <Navigate to="/organiser/apply" replace />;
  return <>{children}</>;
}
