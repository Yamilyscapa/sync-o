import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { setReorderPoint } from "../../db/products/reads.js";
import { SKU_REGEX, SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku, guardUuid } from "../_guards.js";
import { WAREHOUSE_ID_DESC, WAREHOUSE_RESOLVER_HINT } from "./write.js";

export const setReorderPointTool = tool({
  name: "setReorderPoint",
  needsApproval: true,
  description:
    "Set the per-(product, warehouse) reorder threshold (min_stock). When `quantity` falls to or below this value, the pair appears in listLowStock with `useReorder: true`. Creates the stock row (qty=0) if none exists yet. Use 0 to clear. Resolve SKU and warehouse via resolveProduct / resolveWarehouse FIRST.",
  parameters: z.object({
    sku: z
      .string()
      .regex(SKU_REGEX)
      .describe(`${SKU_REGEX_DESC}. Canonical only.`),
    warehouseId: z.string().describe(WAREHOUSE_ID_DESC),
    minStock: z
      .number()
      .nonnegative()
      .describe("Reorder threshold in units (>= 0). Set 0 to clear."),
  }),
  execute: async ({ sku, warehouseId, minStock }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(sku);
    if (skuErr) return skuErr;
    const whErr = guardUuid(warehouseId, "warehouseId", WAREHOUSE_RESOLVER_HINT);
    if (whErr) return whErr;

    try {
      const result = await setReorderPoint(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        sku,
        warehouseId,
        minStock,
      );
      if (!result.ok) {
        switch (result.error.kind) {
          case "product_not_found":
            return `error: no se encontró el producto con SKU ${result.error.sku}`;
          case "warehouse_not_found":
            return `error: no se encontró la bodega ${result.error.warehouseId}`;
          case "cross_org":
            return `error: la bodega o el producto pertenece a otra organización`;
          case "unknown":
            return `error: ${result.error.message}`;
        }
      }
      const r = result.row;
      const bodega = r.warehouse_code ?? r.warehouse_id ?? "?";
      return `punto de reorden actualizado: ${r.sku} en bodega ${bodega} → ${minStock}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
