import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthVariables } from "./auth.js";
import {
  resumeAgent,
  runAgent,
  type AgentContext,
  type ApprovalDecision,
} from "./agent.js";

const RunBody = z.object({
  input: z.string().min(1),
  organizationId: z.string().uuid().optional(),
});

const ResumeBody = z.object({
  organizationId: z.string().uuid().optional(),
  serializedState: z.string().min(1),
  decisions: z.array(
    z.object({
      toolName: z.string().min(1),
      approved: z.boolean(),
      rejectionMessage: z.string().optional(),
    }),
  ),
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
    jwt,
  };
  const decisions: ApprovalDecision[] = parsed.data.decisions;
  const result = await resumeAgent(
    parsed.data.serializedState,
    decisions,
    context,
  );
  return c.json({ userId: user.id, result });
});
