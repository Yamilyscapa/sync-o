import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { env } from "./env.js";

// Service-role client: bypasses RLS. Use for system tasks only.
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

// Per-request, user-scoped client. RLS enforced via the user's JWT.
export function userSupabase(jwt: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
    },
  });
}

export async function verifyUserJWT(token: string): Promise<User | null> {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
