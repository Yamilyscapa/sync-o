import { Hono } from "hono";
import { z } from "zod";
import { run } from "@openai/agents";
import { requireAuth, type AuthVariables } from "./auth.js";
import { buildAgent, type AgentContext } from "./agent.js";
import { userSupabase } from "./supabase.js";

const RunBody = z.object({
  input: z.string().min(1),
  organizationId: z.string().uuid().optional(),
});

export const app = new Hono<{ Variables: AuthVariables }>();

app.get("/health", (c) => c.json({ ok: true }));

app.post("/agent/run", requireAuth, async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = RunBody.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const jwt = c.get("jwt");
  const context: AgentContext = {
    userId: user.id,
    organizationId: parsed.data.organizationId,
    supabase: userSupabase(jwt),
  };
  const result = await run(buildAgent(), parsed.data.input, { context });
  return c.json({
    userId: user.id,
    output: result.finalOutput,
  });
});
