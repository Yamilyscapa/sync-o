import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthVariables } from "./auth.js";
import {
  resumeAgent,
  runAgent,
  type AgentContext,
  type ApprovalDecision,
} from "./agent.js";
import { userSupabase } from "./supabase.js";
import {
  getConversation,
  listConversations,
} from "./db/conversations/reads.js";

const RunBody = z.object({
  input: z.string().min(1),
  organizationId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
});

const ResumeBody = z
  .object({
    organizationId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    serializedState: z.string().min(1).optional(),
    decisions: z.array(
      z.object({
        toolName: z.string().min(1),
        approved: z.boolean(),
        rejectionMessage: z.string().optional(),
      }),
    ),
  })
  .refine((b) => b.serializedState || b.conversationId, {
    message: "either serializedState or conversationId is required",
    path: ["serializedState"],
  });

const ListQuery = z.object({
  organizationId: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional(),
});

const GetQuery = z.object({
  organizationId: z.string().uuid(),
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
    conversationId: parsed.data.conversationId,
    jwt,
  };
  const result = await runAgent(parsed.data.input, context);
  return c.json({ userId: user.id, result });
});

app.post("/agent/run/resume", requireAuth, async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = ResumeBody.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const jwt = c.get("jwt");
  const context: AgentContext = {
    userId: user.id,
    organizationId: parsed.data.organizationId,
    conversationId: parsed.data.conversationId,
    jwt,
  };
  const decisions: ApprovalDecision[] = parsed.data.decisions;
  const result = await resumeAgent(
    parsed.data.serializedState ?? null,
    decisions,
    context,
  );
  return c.json({ userId: user.id, result });
});

app.get("/conversations", requireAuth, async (c) => {
  const parsed = ListQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const user = c.get("user");
  const jwt = c.get("jwt");
  const supabase = userSupabase(jwt);
  const rows = await listConversations(
    supabase,
    parsed.data.organizationId,
    user.id,
    { limit: parsed.data.limit, before: parsed.data.before },
  );
  return c.json({ conversations: rows });
});

app.get("/conversations/:id", requireAuth, async (c) => {
  const parsed = GetQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ error: "invalid query", issues: parsed.error.issues }, 400);
  }
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return c.json({ error: "invalid id" }, 400);
  }
  const user = c.get("user");
  const jwt = c.get("jwt");
  const supabase = userSupabase(jwt);
  const result = await getConversation(
    supabase,
    parsed.data.organizationId,
    user.id,
    id,
  );
  if (!result) return c.json({ error: "not_found" }, 404);
  return c.json(result);
});
