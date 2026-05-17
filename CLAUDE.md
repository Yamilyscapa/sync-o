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
- Validate all external input (HTTP bodies, env) with Zod.

## Agent Skills

`.agents/skills/` contains pinned Supabase skill bundles (`supabase`, `supabase-postgres-best-practices`) tracked in `skills-lock.json` (sourced from `supabase/agent-skills` on GitHub). Consult these when writing Supabase queries, RLS, indexes, or migrations.

## MCP

`.mcp.json` configures a Supabase MCP server bound to project `rvgmdkehrnailuadvkps`.
