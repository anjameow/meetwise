import * as React from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { rpc } from "@/lib/api";

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  roles: string[];
  isOrganiser: boolean;
  isAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const qc = useQueryClient();

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      qc.invalidateQueries();
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const roles = useQuery({
    queryKey: ["my_roles", session?.user.id],
    queryFn: () => rpc<string[]>("my_roles"),
    enabled: !!session,
    staleTime: 60_000,
  });

  const value: AuthState = {
    session,
    user: session?.user ?? null,
    loading: loading || (!!session && roles.isLoading),
    roles: roles.data ?? [],
    isOrganiser: (roles.data ?? []).some((r) => r === "organiser" || r === "admin"),
    isAdmin: (roles.data ?? []).includes("admin"),
    signOut: async () => { await supabase.auth.signOut(); qc.clear(); },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
