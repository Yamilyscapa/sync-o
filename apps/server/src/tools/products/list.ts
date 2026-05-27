import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  listBelowReorder,
  listLowStock,
  listProducts,
  listStock,
} from "../../db/products/reads.js";
import { getWarehouseByCode } from "../../db/warehouses/reads.js";
import { getSupabaseFromContext } from "../../supabase.js";

export const listProductsTool = tool({
  name: "listProducts",
  description:
    "List products in the caller's organization, ordered by SKU. Returns sku, name, quantity, price_cents, currency, is_active. `quantity` is the aggregated total across warehouses. Use for catalog browsing. Organization comes from context — never ask the user.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    cursor: z
      .string()
      .nullable()
      .describe("Last sku from previous page, or null for first page"),
    activeOnly: z
      .boolean()
      .describe("If true, only return is_active=true rows"),
  }),
  execute: async ({ limit, cursor, activeOnly }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listProducts(getSupabaseFromContext(ctx), ctx.organizationId, {
        limit,
        cursor: cursor ?? undefined,
        activeOnly,
      });
      return JSON.stringify({ rows, nextCursor: rows.at(-1)?.sku ?? null });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const listStockTool = tool({
  name: "listStock",
  description:
    "List products ordered by stock quantity. Use to answer 'what has the most/least stock'. If `warehouseCode` is provided, scope to that bodega; otherwise aggregate across warehouses. Returns sku, name, quantity (and warehouse fields when scoped). Organization comes from context.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    order: z
      .enum(["asc", "desc"])
      .describe("'desc' = highest stock first, 'asc' = lowest first"),
    warehouseCode: z
      .string()
      .nullable()
      .describe(
        "Optional warehouse short code (uppercase, e.g. MAIN). Null = aggregate across all bodegas.",
      ),
  }),
  execute: async ({ limit, order, warehouseCode }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const supabase = getSupabaseFromContext(ctx);

    try {
      let warehouseId: string | undefined;
      if (warehouseCode) {
        const wh = await getWarehouseByCode(supabase, ctx.organizationId, warehouseCode);
        if (!wh) return `no encontré bodega con código ${warehouseCode}`;
        warehouseId = wh.id;
      }
      const rows = await listStock(supabase, ctx.organizationId, {
        limit,
        order,
        warehouseId,
      });
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const listLowStockTool = tool({
  name: "listLowStock",
  description:
    "List products running low. Two modes: (a) `useReorder: false` — fixed threshold mode, returns rows with quantity <= threshold (org-wide aggregated or scoped by warehouseCode); (b) `useReorder: true` — per-pair mode, returns warehouse-scoped rows where quantity <= min_stock and min_stock > 0 (the per-(product, warehouse) reorder point set via setReorderPoint). Reorder mode ignores `threshold`. Threshold required for fixed mode.",
  parameters: z.object({
    threshold: z
      .number()
      .nonnegative()
      .describe("Inclusive upper bound on quantity (fixed mode only)"),
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    warehouseCode: z
      .string()
      .nullable()
      .describe(
        "Optional warehouse short code (uppercase). Null = aggregated across bodegas (fixed mode) or all bodegas (reorder mode).",
      ),
    useReorder: z
      .boolean()
      .describe(
        "If true, ignore `threshold` and return rows where quantity <= min_stock (per-pair reorder mode). Requires bodegas to have reorder points configured via setReorderPoint.",
      ),
  }),
  execute: async ({ threshold, limit, warehouseCode, useReorder }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const supabase = getSupabaseFromContext(ctx);

    try {
      let warehouseId: string | undefined;
      if (warehouseCode) {
        const wh = await getWarehouseByCode(supabase, ctx.organizationId, warehouseCode);
        if (!wh) return `no encontré bodega con código ${warehouseCode}`;
        warehouseId = wh.id;
      }
      if (useReorder) {
        const rows = await listBelowReorder(supabase, ctx.organizationId, {
          limit,
          warehouseId,
        });
        return JSON.stringify({ rows, mode: "reorder" });
      }
      const rows = await listLowStock(supabase, ctx.organizationId, threshold, {
        limit,
        warehouseId,
      });
      return JSON.stringify({ rows, threshold, mode: "fixed" });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
