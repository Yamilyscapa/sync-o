import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  getStockBreakdownBySku,
  getStockBySku,
  getStockBySkuAndWarehouse,
} from "../../db/products/reads.js";
import { SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getWarehouseByCode } from "../../db/warehouses/reads.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku } from "../_guards.js";

export const readStockBySku = tool({
  name: "readStockBySku",
  description:
    "Read current stock for a product in the caller's organization. Without `warehouseCode`: returns the org-wide total and, if the product spans multiple warehouses, a per-bodega breakdown. With `warehouseCode`: returns the quantity in that bodega only. Only accepts canonical SKUs matching ^[A-Z]{2,5}-\\d{3,}$. For natural-language product references call `resolveProduct` first; for warehouse references call `resolveWarehouse` first (or pass the short code like MAIN / SUR).",
  parameters: z.object({
    sku: z
      .string()
      .describe(
        `${SKU_REGEX_DESC}. MUST be a canonical SKU — if the user referenced the product by name, call resolveProduct FIRST.`,
      ),
    warehouseCode: z
      .string()
      .nullable()
      .describe(
        "Optional warehouse short code (uppercase, e.g. MAIN, SUR). If null, return aggregated total with per-warehouse breakdown.",
      ),
  }),
  execute: async ({ sku, warehouseCode }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(sku);
    if (skuErr) return skuErr;

    const supabase = getSupabaseFromContext(ctx);

    try {
      if (warehouseCode) {
        const wh = await getWarehouseByCode(supabase, ctx.organizationId, warehouseCode);
        if (!wh) return `no encontré bodega con código ${warehouseCode} en esta organización`;
        const row = await getStockBySkuAndWarehouse(
          supabase,
          ctx.organizationId,
          sku,
          wh.id,
        );
        if (!row) return `no encontré el producto con SKU ${sku} en esta organización`;
        return `stock(${row.sku} en ${wh.code}) = ${row.quantity} (${row.name})`;
      }

      const total = await getStockBySku(supabase, ctx.organizationId, sku);
      if (!total) return `no encontré el producto con SKU ${sku} en esta organización`;

      const breakdown = await getStockBreakdownBySku(supabase, ctx.organizationId, sku);
      if (breakdown.length <= 1) {
        return `stock(${total.sku}) = ${total.quantity} (${total.name})`;
      }
      const lines = breakdown
        .map((r) => `  ${r.warehouse_code}: ${r.quantity}`)
        .join("\n");
      return `stock(${total.sku}) = ${total.quantity} total (${total.name})\n${lines}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
