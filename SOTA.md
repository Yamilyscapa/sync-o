# State Of The Art

Snapshot of what the agent can currently do end-to-end. Update on every shipped capability. Order: newest first per section.

Last updated: 2026-05-18

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

### Agent runtime
- HTTP entry: `POST /agent/run`, `POST /agent/run/resume`.
- Auth: Supabase user JWT via `Authorization: Bearer`; context carries `userId` + `organizationId`.
- Multi-org RLS enforced at DB layer; service-role used server-side, scoped queries always include `organization_id`.
- HITL via OpenAI Agents SDK `needsApproval` — runtime-enforced, host renders Spanish preview, resume with explicit decisions per tool.
- 24h prompt cache retention for stable system prompt + tool defs.
- Locale-aware system prompt (default `es-MX`); LLM-facing text English, end-user text Spanish.

### Test harness
- Scenario runner at `tests/run.ts` writes transcripts to `tests/runs/<ts>/`.
- Read full files when reviewing (don't `grep ^U:|^A:` — drops multi-line bodies).

## Not yet capable

- **Conversation persistence.** Threads not stored server-side; client must echo `serializedState` to resume. Plan drafted at `~/.claude/plans/lets-scafold-db-step-sparkling-sedgewick.md`; tables `conversations` + `conversation_messages` + auto-summary not yet built. No "list past chats" surface.
- **Cross-thread context.** No @-mention / semantic search across threads.
- **Orders / purchase orders.** No PO entity; supplier links carry terms but no PO lifecycle.
- **Reporting.** No aggregate endpoints (period sales, COGS, margin) — only raw ledger queries.
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
