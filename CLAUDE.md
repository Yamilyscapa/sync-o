# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: `pnpm` (v11.1.2). ESM only (`"type": "module"`), so relative imports must use the `.js` extension even when authoring `.ts`.

- `pnpm dev` — run server via `tsx watch src/index.ts`
- `pnpm build` — emit `dist/` via `tsc`
- `pnpm start` — run compiled `dist/index.js`
- `pnpm typecheck` — `tsc --noEmit`

No test runner or linter configured.

## Environment

`src/env.ts` parses `process.env` with Zod at module load — missing/invalid vars throw on startup. Required: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`. Optional: `PORT` (default 3000), `NODE_ENV`. See `.env.example`.

## Architecture

Hono HTTP server hosting an OpenAI Agents SDK agent, authenticated by Supabase user JWTs.

Request flow for `POST /agent/run`:
1. `src/index.ts` boots `@hono/node-server` on `env.PORT`.
2. `src/server.ts` defines routes. `requireAuth` middleware (`src/auth.ts`) pulls `Authorization: Bearer <jwt>`, calls `verifyUserJWT` (`src/supabase.ts`), and stashes the Supabase `User` in `c.get("user")`.
3. Body validated with Zod (`{ input: string }`), then `run(buildAgent(), input)` from `@openai/agents` executes the agent and returns `{ userId, output }`.

Agent definition (`src/agent.ts`): `gpt-4o-mini`, `systemPrompt` from `src/prompts/system.ts`, tool list from `src/tools/index.ts`. Currently `tools` is an empty array — `src/tools/products/stock.ts` defines a `readStock` tool but it is not yet wired into the exported list. Register new tools by importing them in `src/tools/index.ts` and pushing into the `tools` export.

Supabase client (`src/supabase.ts`) is server-side and uses the **service-role key** with `autoRefreshToken: false` / `persistSession: false`. Token verification goes through `supabase.auth.getUser(token)` rather than local JWT decode, so `SUPABASE_JWT_SECRET` is currently env-required but unused in code.

## Conventions

- TypeScript strict, `module: NodeNext`, `target: ES2022`, `rootDir: src`, `outDir: dist`.
- Use `.js` suffix on relative imports (NodeNext ESM requirement).
- **Zod is mandatory at every I/O boundary.** This includes HTTP request bodies, env vars, external API responses, and **every DB row returned from Supabase/PostgREST**. Define `XxxSchema = z.object({...})` next to its `type Xxx = z.infer<typeof XxxSchema>`; never hand-write the type. Parse before returning from `src/db/<entity>/{reads,writes}.ts`. Use `z.coerce.number()` for numeric DB columns (PostgREST returns them as strings). Do not `as Foo` cast DB results — Supabase client types are not authoritative.
- Layer separation: `src/db/<entity>/` holds pure DB functions (with Zod parsing); `src/tools/<entity>/` holds thin LLM-facing tool wrappers that call the db layer.

## Commit convention

Conventional Commits: `type(scope): message`.

- Allowed types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`, `build`, `ci`, `style`, `revert`.
- `scope` is a short noun for the area touched: `db`, `products`, `agent`, `auth`, `tools`, `server`, `env`, `migrations`, etc. Omit only when truly global.
- Subject: imperative, lowercase, no trailing period, ≤72 chars.
- Breaking change: append `!` after scope, e.g. `refactor(db)!: drop legacy column`.
- Body (optional): explain *why*, not *what*. Wrap at 72 cols.

Examples:
- `feat(products): add searchProducts tool`
- `fix(auth): reject expired tokens before db call`
- `chore(migrations): rename anon key env var`
- `refactor(tools)!: split db layer from tool wrappers`

## Agent mutation policy (Human-in-the-loop)

**Every agent-driven create, update, or delete operation MUST be a human-in-the-loop (HITL) tool call using the OpenAI Agents SDK `needsApproval` option (or equivalent interruption mechanism).** Read-only operations are exempt.

HITL is **SDK-enforced**, not prompt-enforced. The runtime suspends the run before the tool executes; the host application surfaces the pending approval to the user; the run resumes only after explicit approval. The agent cannot bypass the approval round-trip.

- Every write-capable tool is defined with `needsApproval: true` in its `tool({...})` definition.
- The approval message restates parsed parameters in user-facing Spanish (default `es-MX`) — product name, delta or new value, reason/note — not raw SKUs alone. Examples:
  - Intake of 50 unidades → "¿Confirmas que quieres agregar 50 tornillos al almacén?"
  - Recount adjustment to 55 (current 60) → "¿Confirmas que quieres ajustar el stock de aceite de oliva a 55 unidades (ajuste de -5)?"
- On rejection, the agent acknowledges and asks what to change. On DB / trigger error (e.g. would-be-negative stock), the error is surfaced verbatim translated to Spanish; the agent must NOT auto-retry with adjusted parameters.
- Server response payload must expose pending approvals (e.g. `{ output, pendingApprovals }`) so the client can render the prompt; subsequent calls resume the run with the user's decision.
- The system prompt may still describe the user-facing wording (Spanish, restate params); it is documentation, not a security mechanism.

This rule is durable: it applies to all future entities (products, suppliers, orders, etc.), not just stock movements. Adding a new mutation without HITL is a defect.

## Agent Skills

`.agents/skills/` contains pinned Supabase skill bundles (`supabase`, `supabase-postgres-best-practices`) tracked in `skills-lock.json` (sourced from `supabase/agent-skills` on GitHub). Consult these when writing Supabase queries, RLS, indexes, or migrations.

## MCP

`.mcp.json` configures a Supabase MCP server bound to project `rvgmdkehrnailuadvkps`.
