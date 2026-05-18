# sync-o

Warehouse manager agent. Hono HTTP server hosting an OpenAI Agents SDK agent over a Supabase Postgres tenant. End-user talks Spanish (`es-MX`); LLM internals stay English.

## Stack

- Runtime: Node ESM, TypeScript strict, `module: NodeNext`
- HTTP: Hono + `@hono/node-server`
- Agent: `@openai/agents` (`gpt-5-mini`, 24h prompt cache)
- DB: Supabase Postgres, RLS by `organization_id`; service-role key server-side
- Validation: Zod at every I/O boundary
- Pkg mgr: `pnpm@11.1.2`

## Layout

```
src/
  index.ts          Boot @hono/node-server on env.PORT
  server.ts         Routes + Zod request bodies
  auth.ts           Bearer JWT -> Supabase user -> c.set("user")
  supabase.ts       Service-role client + getSupabaseFromContext
  env.ts            process.env Zod parse (throws on boot)
  agent.ts          buildAgent / runAgent / resumeAgent (HITL + persistence)
  agent/history.ts  Bounded replay window (40 items / 24k chars, pair-safe)
  agent/summary.ts  Rolling Spanish summary of dropped turns (gpt-5-nano)
  agent/analysis.ts Read-only analysis sub-agent exposed as `analyze` tool + output sanitizer
  prompts/system.ts System prompt builder (locale-aware)
  prompts/analysis.ts Analysis sub-agent prompt (locale-aware)
  tools/            LLM-facing tool wrappers (see tools.md)
  db/<entity>/      reads.ts / writes.ts / schema.ts (Zod rows)
supabase/migrations Append-only SQL
tests/              Harness scenarios; outputs in tests/runs/
```

## Commands

- `pnpm dev` — `tsx watch src/index.ts`
- `pnpm build` — `tsc` to `dist/`
- `pnpm start` — `node dist/index.js`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm typecheck:tests` — same, tests project
- `pnpm test:agent` — `tsx --env-file=.env tests/run.ts`
- `pnpm test:conversation` — persistence + bounded-context + HITL-restart suite (`tests/conversation.ts`)
- `pnpm test:analysis` — analysis sub-agent scenarios (`tests/analysis.ts`)

## Env

Required: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`.
Optional: `PORT` (3000), `NODE_ENV`. See `.env.example`.

## HTTP

All routes require `Authorization: Bearer <jwt>`.

- `POST /agent/run` — body `{ input, organizationId?, conversationId? }`. Server creates a new conversation if `conversationId` omitted; otherwise continues the named thread. Returns `{ result: { kind: "final", conversationId, output } | { kind: "awaiting_approval", conversationId, serializedState, approvals } }`.
- `POST /agent/run/resume` — body `{ decisions, serializedState?, conversationId?, organizationId? }`. EITHER `serializedState` OR `conversationId` is required; passing only `conversationId` reloads the stored `pending_state` from the row (restart-safe HITL).
- `GET /conversations?organizationId=&limit=&before=` — sidebar list, newest-first by `last_message_at`. RLS-filtered by user + org.
- `GET /conversations/:id?organizationId=` — conversation header + ordered messages (raw `AgentInputItem` payloads). RLS-filtered.

## Invariants

- Zod parses every DB row. No `as Foo` on Supabase results. Use `z.coerce.number()` for numeric columns.
- Every agent create/update/delete tool is `needsApproval: true`. Runtime suspends the run; host surfaces preview; resume on user decision.
- LLM-facing strings (system prompt, tool descriptions, schema enums) are English. Spanish only at the projection boundary (`src/tools/<entity>/_project.ts`).
- Relative imports use `.js` suffix even from `.ts` (NodeNext ESM).
- Conventional Commits: `type(scope): message`.
- Conversation replay is bounded: at most one summary item + 40 history items (24k chars) + new user input pass to the model per turn, regardless of thread age. Dropped older items are encoded into a rolling Spanish summary stored on the conversation row.

See `CLAUDE.md` for the full rule set and `TOOLS.md` / `SOTA.md` for capability scope.
