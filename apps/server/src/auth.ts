import type { MiddlewareHandler } from "hono";
import type { User } from "@supabase/supabase-js";
import { verifyUserJWT } from "./supabase.js";

export type AuthVariables = {
  user: User;
  jwt: string;
};

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const token = header.slice("Bearer ".length).trim();
  const user = await verifyUserJWT(token);
  if (!user) return c.json({ error: "invalid token" }, 401);
  c.set("user", user);
  c.set("jwt", token);
  await next();
};
