# TOOLS

LLM-facing tools registered in `src/tools/index.ts`. Read tools are free to call. Write tools (`needsApproval: true`) suspend the run for human approval.

Legend: 🔒 = HITL, read tools unmarked.

## Products (`src/tools/products/`)

| Tool | Purpose |
|---|---|
| `resolveProduct` | NL product reference → ranked candidate SKUs with `ambiguous` flag. Call before any SKU-keyed tool when input is a name. |
| `readStockBySku` | Current quantity by canonical SKU. |
| `listProducts` | Catalog page (sku, name, qty, price, currency, active). Cursor on sku. |
| `listStock` | Stock view across catalog. |
| `listLowStock` | Catalog rows under min threshold. |

## Suppliers (`src/tools/suppliers/`)

Reads:
| Tool | Purpose |
|---|---|
| `listSuppliers` | Page of suppliers, alpha by name. |
| `getSupplier` | Single supplier by UUID. |
| `resolveSupplier` | NL supplier reference → ranked candidates. |
| `listProductSuppliers` | All suppliers linked to a SKU. |
| `listSupplierProducts` | All SKUs linked to a supplier. |

Writes (🔒):
| Tool | Purpose |
|---|---|
| `createSupplier` | New supplier in org. |
| `updateSupplier` | Patch supplier fields. |
| `deactivateSupplier` | Soft-delete (sets `is_active=false`); falls back when in use. |
| `linkProductSupplier` | Bind SKU ↔ supplier with terms. |
| `unlinkProductSupplier` | Drop a SKU ↔ supplier link. |
| `setPreferredSupplier` | Mark one link as preferred per SKU. |

## Movements (`src/tools/movements/`)

Append-only ledger of stock_movements.

Reads:
| Tool | Purpose |
|---|---|
| `listStockMovements` | Recent movements, newest first; filter by `reason` or `sinceIso`. |
| `getStockHistory` | Movements for a SKU. |

Writes (🔒):
| Tool | Purpose |
|---|---|
| `recordStockMovement` | Post a signed delta (`intake`/`sale`/`adjustment`/`loss`/`transfer`/`reversal`/`initial`). Trigger updates `products.quantity`; rejects negative stock. |
| `reverseStockMovement` | Post compensating row (`delta=-original.delta`, `reason='reversal'`). Each movement reversible once; reversal of a reversal blocked. |

## Conventions

- **Resolver first.** SKU/supplierId params accept any string at the Zod boundary; tool-layer `guardSku`/`guardUuid` returns an actionable error pointing to `resolveProduct` / `resolveSupplier` when the model passes a name. Prevents silent failures + opaque DB errors.
- **Projection.** Tools that return rows pass them through `src/tools/<entity>/_project.ts` to translate DB enums/columns to Spanish before serializing. The agent never sees raw `default_lead_time_days` / `unit_cost_cents`.
- **Errors.** DB write functions return a discriminated `WriteError` union; tool wrappers translate to Spanish. Agent must NOT auto-retry on `negative_stock`, `*_required`, `cross_org` — surface verbatim, ask user.
- **HITL preview.** `src/tools/movements/preview.ts` (and per-entity equivalents) restates parsed args in Spanish for the approval dialog ("¿Confirmas que quieres agregar 50 tornillos al almacén?"), not raw SKUs.

## Adding a tool

1. `src/db/<entity>/{schema,reads,writes}.ts` — Zod row schema, pure DB fn returning either parsed rows or a `WriteError` union.
2. `src/tools/<entity>/<name>.ts` — `tool({ name, description (English), parameters: z.object({...}), needsApproval: <bool>, execute })`. Resolve ctx via `getSupabaseFromContext`.
3. Guard inputs with `_guards.ts` helpers; project outputs with `_project.ts`.
4. Re-export in `src/tools/<entity>/index.ts` (root `src/tools/index.ts` already concatenates).
5. If mutating: add a Spanish preview branch in `preview.ts`.

Description budget per tool ≈ 1024 chars (OpenAI Agents SDK cap). Over → opaque 500 at run time.
