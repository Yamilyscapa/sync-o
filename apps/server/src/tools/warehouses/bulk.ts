import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { bulkInitializeStock } from "../../db/movements/writes.js";
import { SKU_REGEX_DESC, SKU_REGEX } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardUuid } from "../_guards.js";
import { WAREHOUSE_ID_DESC, WAREHOUSE_RESOLVER_HINT } from "./write.js";

const SUPPLIER_ID_DESC =
  "Supplier UUID. If the user gave a name, call resolveSupplier FIRST and use the returned candidates[0].id.";

export const bulkInitializeStockTool = tool({
  name: "bulkInitializeStock",
  needsApproval: true,
  description:
    "Bootstrap initial stock for a single warehouse. Creates one 'initial' movement per item in a single HITL approval. Use ONLY for first-time bulk load of a bodega (not for ongoing intakes — use recordStockMovement). All SKUs must be canonical and resolved first; supplierId is required per item. Each item also requires unitCostCents. Items max 100 per call. If any row's trigger fails, the whole batch rolls back.",
  parameters: z.object({
    warehouseId: z.string().describe(WAREHOUSE_ID_DESC),
    items: z
      .array(
        z.object({
          sku: z
            .string()
            .regex(SKU_REGEX)
            .describe(`${SKU_REGEX_DESC}. Canonical only — resolve via resolveProduct first.`),
          quantity: z
            .number()
            .positive()
            .describe("Positive quantity to load as initial stock"),
          unitCostCents: z
            .number()
            .int()
            .nonnegative()
            .describe("Unit purchase cost in MXN cents"),
          supplierId: z.string().describe(SUPPLIER_ID_DESC),
          note: z
            .string()
            .nullable()
            .describe("Optional Spanish note attached to this row's movement"),
        }),
      )
      .min(1)
      .max(100)
      .describe("List of items to load (1-100)"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const idErr = guardUuid(args.warehouseId, "warehouseId", WAREHOUSE_RESOLVER_HINT);
    if (idErr) return idErr;
    for (const item of args.items) {
      const supplierErr = guardUuid(
        item.supplierId,
        "supplierId",
        `resolveSupplier({ query: "<name>" })`,
      );
      if (supplierErr) return supplierErr;
    }

    try {
      const result = await bulkInitializeStock(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        ctx.userId,
        args.warehouseId,
        args.items.map((i) => ({
          sku: i.sku,
          quantity: i.quantity,
          unitCostCents: i.unitCostCents,
          supplierId: i.supplierId,
          note: i.note,
        })),
      );

      if (!result.ok) {
        switch (result.error.kind) {
          case "product_not_found":
            return `error: no encontré el producto con SKU ${result.error.sku} en esta organización`;
          case "warehouse_not_found":
            return `error: no encontré la bodega ${result.error.warehouseId} en esta organización`;
          case "supplier_not_found":
            return `error: no encontré el proveedor ${result.error.supplierId}`;
          case "cross_org":
            return `error: producto, bodega o proveedor pertenece a otra organización`;
          case "cost_required":
            return `error: falta el costo unitario para ${result.error.sku}`;
          case "negative_stock":
            return `error: ${result.error.message}`;
          case "unknown":
            return `error: ${result.error.message}`;
          default:
            return `error: ${result.error.kind}`;
        }
      }

      return `carga inicial registrada: ${result.count} movimientos en bodega ${args.warehouseId}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
