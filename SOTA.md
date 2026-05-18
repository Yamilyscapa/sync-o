# State Of The Art

Snapshot of what the agent can currently do end-to-end. Update on every shipped capability. Order: newest first per section.

Last updated: 2026-05-18 (analysis sub-agent)

## Capabilities

### Inventory — Products
- Browse catalog (`listProducts`, paginated).
- Check stock by SKU (`readStockBySku`).
- Stock overview + low-stock filter (`listStock`, `listLowStock`).
- Resolve NL product references → ranked SKU candidates with ambiguity flag (`resolveProduct`).

### Inventory — Suppliers
- Browse / get / resolve suppliers (`listSuppliers`, `getSupplier`, `resolveSupplier`).
- View supplier ↔ product links from either side (`listProductSuppliers`, `listSupplierProducts`).
- Create / update / deactivate supplier (HITL).
- Link / unlink SKU ↔ supplier with terms; set preferred supplier per SKU (HITL).

### Inventory — Movements (append-only ledger)
- Record signed delta in any reason: `intake`, `sale`, `adjustment`, `loss`, `transfer`, `reversal`, `initial` (HITL).
  - `intake` / `initial` require `supplierId`; defaults `unit_cost_cents` to last cost.
  - `sale` defaults `unit_price_cents` to last sale, then catalog.
  - Negative-stock attempts rejected by DB trigger.
- Reverse a movement by posting a compensating row (HITL). One reversal per original; reversal-of-reversal blocked.
- List recent movements (`listStockMovements`), filterable by reason + ISO datetime; per-SKU history (`getStockHistory`).
- Supplier name surfaced on movement rows (joined via PostgREST + Zod-parsed `MovementInsertedRowSchema` + `flattenInsertedMovement`).

### Inventory — Analysis (read-only sub-agent)
- Exposed to main agent as a single `analyze` tool (`Agent.asTool`); main agent delegates inventory analysis verbatim and surfaces the prose result.
- Sub-agent (`sync-o-analysis`, `gpt-5-mini`, 24h cache) has the full read toolset: product reads, supplier reads, `listStockMovements`, `getStockHistory`. NO write tools.
- v1 analyses: **reposición** (velocidad × tiempo de entrega × 1.5 safety factor, vs current qty + min_order_qty), **ventas / rotación** (sum of |delta| per SKU in window, default 30d), **márgenes y costos** (price vs last unit cost from preferred supplier link), **desempeño del proveedor** (observed lead time between intakes, cost variance).
- Output discipline enforced in `src/prompts/analysis.ts`: Spanish-only, prose first, numbers always carry units ($MXN, días, %, unidades/día), no scaffolding labels, no trailing offers, no follow-up questions.
- Defense-in-depth sanitizer (`sanitizeAnalysisOutput`) post-processes sub-agent output before main agent receives it: strips banned English (lead time / top movers / dead stock / etc.), corporate headers, and trailing "Si quieres…" patterns.
- Scenario suite at `tests/analysis.ts` (`pnpm test:analysis`).

### Agent runtime
- HTTP entry: `POST /agent/run`, `POST /agent/run/resume`.
- Auth: Supabase user JWT via `Authorization: Bearer`; context carries `userId` + `organizationId`.
- Multi-org RLS enforced at DB layer; service-role used server-side, scoped queries always include `organization_id`.
- HITL via OpenAI Agents SDK `needsApproval` — runtime-enforced, host renders Spanish preview, resume with explicit decisions per tool.
- 24h prompt cache retention for stable system prompt + tool defs.
- Locale-aware system prompt (default `es-MX`); LLM-facing text English, end-user text Spanish.

### Conversation persistence
- Tables `conversations` + `conversation_messages` with per-user + per-org RLS, `set_updated_at` trigger, monotonic per-conversation `seq` via before-insert trigger.
- Server issues `conversationId` on the first turn; follow-up turns pass it back to continue. `GET /conversations` (sidebar list) and `GET /conversations/:id` (full thread) exposed via user-JWT client → RLS filters.
- **Bounded replay** (`src/agent/history.ts`): every continuation turn sends at most a rolling summary + 40 history items / 24k chars + the new user input to the model, regardless of thread age. Pair-safety preserves `function_call ↔ function_call_result` across the window boundary so the model never sees orphaned tool turns.
- **Rolling summary** (`src/agent/summary.ts`): after every `final` turn, if the window dropped items past the prior `summary_through_seq`, a fire-and-forget `gpt-5-nano` call rewrites the conversation summary in neutral es-MX (≤280 chars), merging the prior summary with newly dropped items.
- **HITL restart-safe**: when a turn yields `awaiting_approval`, the serialized `RunState` + the approval previews are persisted on the row (`pending_state`, `pending_approvals`, `status='awaiting_approval'`). `POST /agent/run/resume` accepts either the inline `serializedState` (back-compat) OR just `conversationId` (server reloads from the row). Cleared back to `active` on approval.
- Integration suite at `tests/conversation.ts` (`pnpm test:conversation`) covers multi-turn coherence, window cap + pair-safety unit, tool resolution order, and HITL restart end-to-end.

### Test harness
- Scenario runner at `tests/run.ts` writes transcripts to `tests/runs/<ts>/`.
- Read full files when reviewing (don't `grep ^U:|^A:` — drops multi-line bodies).

## Not yet capable

- **Cross-thread context.** No @-mention / semantic search across threads. No pgvector index over message payloads.
- **Conversation UI.** API ready (`GET /conversations`, `GET /conversations/:id`); no sidebar / archive surface.
- **Title editing.** Auto-derived from the first user message; no rename endpoint.
- **Orders / purchase orders.** No PO entity; supplier links carry terms but no PO lifecycle.
- **Aggregate reporting endpoints.** No HTTP routes for period sales, COGS, or margin reports — only raw ledger queries + ad-hoc analysis via the `analyze` sub-agent.
- **Attachments.** No file/image upload on movements or suppliers.
- **Multi-participant threads.** Each conversation is single-user.
- **Archive/delete UI for threads.** Status column planned but no surface.
- **Cost / price history views.** Values stored on each movement; no dedicated read tool to chart them.
- **Bulk operations.** No batch movement insert; one tool call per delta.

## Known constraints

- OpenAI Agents SDK tool description cap ≈ 1024 chars per tool; over → opaque 500 at run time.
- Service-role client bypasses RLS; every DB function MUST filter by `organization_id` explicitly. Never trust the client to scope.
- Tool descriptions, schema enums, and system prompt are English-only — token-cost reason. Spanish lives in `_project.ts` and approval-preview layer only.

## How to update this file

When a capability ships:
1. Move it from **Not yet capable** to the relevant **Capabilities** subsection (or add a new subsection).
2. Bump `Last updated`.
3. If the change adds a constraint or removes one, edit **Known constraints**.

Treat this as the canonical "what does sync-o do today" reference for new contributors and for the agent itself when asked about its scope.
