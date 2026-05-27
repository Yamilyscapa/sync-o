import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { transferStock } from "../../db/movements/writes.js";
import { SKU_REGEX, SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku, guardUuid } from "../_guards.js";
import { WAREHOUSE_ID_DESC, WAREHOUSE_RESOLVER_HINT } from "./write.js";

export const transferStockTool = tool({
  name: "transferStock",
  needsApproval: true,
  description:
    "Move a positive quantity of one SKU from one warehouse to another in a single atomic operation (one HITL approval covers both legs). Posts two reason='transfer' movements transactionally — if either leg fails (e.g. negative_stock at origin) both roll back. Use this for bodega-to-bodega moves instead of two sequential recordStockMovement calls. Resolve SKU via resolveProduct and both bodegas via resolveWarehouse FIRST.",
  parameters: z.object({
    sku: z
      .string()
      .regex(SKU_REGEX)
      .describe(
        `${SKU_REGEX_DESC}. Canonical only — resolve via resolveProduct first.`,
      ),
    fromWarehouseId: z.string().describe(`Origin ${WAREHOUSE_ID_DESC}`),
    toWarehouseId: z.string().describe(`Destination ${WAREHOUSE_ID_DESC}`),
    quantity: z
      .number()
      .positive()
      .describe("Positive number of units to transfer"),
    note: z.string().nullable().describe("Optional Spanish note explaining the transfer"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(args.sku);
    if (skuErr) return skuErr;
    const fromErr = guardUuid(args.fromWarehouseId, "fromWarehouseId", WAREHOUSE_RESOLVER_HINT);
    if (fromErr) return fromErr;
    const toErr = guardUuid(args.toWarehouseId, "toWarehouseId", WAREHOUSE_RESOLVER_HINT);
    if (toErr) return toErr;

    try {
      const result = await transferStock(getSupabaseFromContext(ctx), {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        sku: args.sku,
        fromWarehouseId: args.fromWarehouseId,
        toWarehouseId: args.toWarehouseId,
        quantity: args.quantity,
        note: args.note,
      });

      if (!result.ok) {
        switch (result.error.kind) {
          case "product_not_found":
            return `error: no se encontró el producto con SKU ${result.error.sku}`;
          case "warehouse_not_found":
            return `error: no se encontró la bodega ${result.error.warehouseId}`;
          case "negative_stock":
            return `error: el traslado dejaría el stock en negativo en la bodega de origen`;
          case "cross_org":
            return `error: alguna de las bodegas o el producto pertenece a otra organización`;
          case "unknown":
            return `error: ${result.error.message}`;
          default:
            return `error: ${result.error.kind}`;
        }
      }

      const out = result.out;
      const credit = result.in;
      return `traslado registrado: ${args.quantity} unidades de ${out.sku} de bodega ${out.warehouse_code ?? "?"} a ${credit.warehouse_code ?? "?"} — ids=${out.id}, ${credit.id}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
