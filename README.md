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
  agent.ts          buildAgent / runAgent / resumeAgent (HITL)
  prompts/system.ts System prompt builder (locale-aware)
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

## Env

Required: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`.
Optional: `PORT` (3000), `NODE_ENV`. See `.env.example`.

## HTTP

- `POST /agent/run` — body `{ input: string }`, header `Authorization: Bearer <jwt>`. Returns `{ kind: "final", output } | { kind: "awaiting_approval", serializedState, approvals }`.
- `POST /agent/run/resume` — body `{ serializedState, decisions: [{ toolName, approved, rejectionMessage? }] }`.

## Invariants

- Zod parses every DB row. No `as Foo` on Supabase results. Use `z.coerce.number()` for numeric columns.
- Every agent create/update/delete tool is `needsApproval: true`. Runtime suspends the run; host surfaces preview; resume on user decision.
- LLM-facing strings (system prompt, tool descriptions, schema enums) are English. Spanish only at the projection boundary (`src/tools/<entity>/_project.ts`).
- Relative imports use `.js` suffix even from `.ts` (NodeNext ESM).
- Conventional Commits: `type(scope): message`.

See `CLAUDE.md` for the full rule set and `TOOLS.md` / `SOTA.md` for capability scope.
