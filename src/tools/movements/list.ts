import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  getMovementsBySku,
  listMovements,
} from "../../db/movements/reads.js";
import { MovementReasonSchema } from "../../db/movements/schema.js";
import { SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku, guardUuid } from "../_guards.js";
import { projectMovement } from "./_project.js";
import { WAREHOUSE_RESOLVER_HINT } from "../warehouses/write.js";

export const listStockMovements = tool({
  name: "listStockMovements",
  description:
    "List recent stock movements for the organization, newest first. Optionally filter by `reason`, ISO datetime `sinceIso`, or `warehouseId`. Read-only. Organization comes from context.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    reason: MovementReasonSchema.nullable().describe(
      "Optional reason filter, or null for all",
    ),
    sinceIso: z
      .string()
      .nullable()
      .describe(
        "Optional ISO 8601 datetime lower bound (e.g. '2026-05-17T00:00:00Z'), or null",
      ),
    warehouseId: z
      .string()
      .nullable()
      .describe(
        "Optional warehouse UUID filter. Resolve names via resolveWarehouse first; null = all warehouses.",
      ),
  }),
  execute: async ({ limit, reason, sinceIso, warehouseId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const warehouseErr = guardUuid(warehouseId, "warehouseId", WAREHOUSE_RESOLVER_HINT);
    if (warehouseErr) return warehouseErr;

    try {
      const rows = await listMovements(getSupabaseFromContext(ctx), ctx.organizationId, {
        limit,
        reason: reason ?? undefined,
        sinceIso: sinceIso ?? undefined,
        warehouseId: warehouseId ?? undefined,
      });
      return JSON.stringify({ rows: rows.map(projectMovement) });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const getStockHistory = tool({
  name: "getStockHistory",
  description:
    "Return the movement history of a single product by canonical SKU, newest first. Optional `warehouseId` scopes to one bodega. Read-only. SKU must match ^[A-Z]{2,5}-\\d{3,}$ — resolve natural-language references via `resolveProduct` first.",
  parameters: z.object({
    sku: z
      .string()
      .describe(
        `${SKU_REGEX_DESC}. MUST be a canonical SKU — if the user referenced the product by name, call resolveProduct FIRST.`,
      ),
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    warehouseId: z
      .string()
      .nullable()
      .describe(
        "Optional warehouse UUID filter. Resolve names/codes via resolveWarehouse first; null = all warehouses.",
      ),
    reason: MovementReasonSchema.nullable().describe(
      "Optional reason filter, or null for all",
    ),
    sinceIso: z
      .string()
      .nullable()
      .describe(
        "Optional ISO 8601 datetime lower bound (e.g. '2026-05-17T00:00:00Z'), or null",
      ),
  }),
  execute: async ({ sku, limit, warehouseId, reason, sinceIso }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(sku);
    if (skuErr) return skuErr;
    const whErr = guardUuid(warehouseId, "warehouseId", WAREHOUSE_RESOLVER_HINT);
    if (whErr) return whErr;

    try {
      const rows = await getMovementsBySku(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        sku,
        {
          limit,
          warehouseId: warehouseId ?? undefined,
          reason: reason ?? undefined,
          sinceIso: sinceIso ?? undefined,
        },
      );
      return JSON.stringify({ rows: rows.map(projectMovement) });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
