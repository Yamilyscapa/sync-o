import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { MovementReasonSchema } from "../../db/movements/schema.js";
import { recordMovement } from "../../db/movements/writes.js";
import { SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku, guardUuid } from "../_guards.js";
import { REASON_ES } from "./_project.js";

export const recordStockMovement = tool({
  name: "recordStockMovement",
  needsApproval: true,
  description:
    "Register a stock movement (intake/sale/adjustment/loss/transfer/reversal/initial). Human-in-the-loop. Resolve non-canonical product/supplier refs via resolveProduct/resolveSupplier FIRST. delta is signed and non-zero. intake/initial: supplierId REQUIRED; unitCostCents may be null (defaults to last cost; required for initial). sale: unitPriceCents may be null (defaults to last sale price, then catalog). adjustment/loss/transfer/reversal: supplierId/cost/price MUST be null. Reversal inherits from original via trigger. Do not chat-ask for price/cost when null can default; only ask if tool returns price_required/cost_required/supplier_required.",
  parameters: z.object({
    sku: z
      .string()
      .describe(
        `${SKU_REGEX_DESC}. MUST be a canonical SKU — never pass a product name. If the user referenced the product by name, call resolveProduct FIRST and use the returned candidate's sku.`,
      ),
    delta: z
      .number()
      .refine((n) => n !== 0, { message: "delta must be non-zero" })
      .describe("Signed change in quantity. Positive adds, negative removes."),
    reason: MovementReasonSchema.describe(
      "One of: intake (entrada), sale (venta), adjustment (ajuste), loss (merma), transfer (traslado), reversal (reversa), initial (carga inicial)",
    ),
    note: z.string().nullable().describe("Optional free-text note in Spanish"),
    relatedMovementId: z
      .string()
      .nullable()
      .describe(
        "Full UUID of the movement being reversed; required if reason='reversal', else null. NEVER pass a short id prefix — use the full UUID returned by listStockMovements or getStockHistory.",
      ),
    supplierId: z
      .string()
      .nullable()
      .describe(
        "Supplier UUID. REQUIRED for intake/initial. Null for sale/adjustment/loss/transfer/reversal. MUST be a UUID — if the user gave a name, call resolveSupplier FIRST and pass the returned candidates[0].id.",
      ),
    unitCostCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "Unit purchase cost in MXN cents. Used for intake/initial. Pass null for recurring intakes to default to the last known cost from this supplier; required for `initial`. Null for sale/adjustment/loss/transfer/reversal.",
      ),
    unitPriceCents: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        "Unit sale price in MXN cents. Used for sale. Pass null to default to the last sale price (then catalog price). Null for intake/initial/adjustment/loss/transfer/reversal.",
      ),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(args.sku);
    if (skuErr) return skuErr;
    const supplierErr = guardUuid(
      args.supplierId,
      "supplierId",
      `resolveSupplier({ query: "<name>" })`,
    );
    if (supplierErr) return supplierErr;
    const relatedErr = guardUuid(
      args.relatedMovementId,
      "relatedMovementId",
      `listStockMovements or getStockHistory`,
    );
    if (relatedErr) return relatedErr;

    try {
      const result = await recordMovement(getSupabaseFromContext(ctx), {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        sku: args.sku,
        delta: args.delta,
        reason: args.reason,
        note: args.note,
        relatedMovementId: args.relatedMovementId,
        supplierId: args.supplierId,
        unitCostCents: args.unitCostCents,
        unitPriceCents: args.unitPriceCents,
      });

      if (!result.ok) {
        switch (result.error.kind) {
          case "product_not_found":
            return `error: no se encontró el producto con SKU ${result.error.sku} en esta organización`;
          case "negative_stock":
            return `error: el movimiento dejaría el stock en negativo (${result.error.message})`;
          case "cross_org":
            return `error: el producto o proveedor pertenece a otra organización`;
          case "price_required":
            return `error: price_required — no hay precio de venta previo ni de catálogo para ${result.error.sku}. Pregunta al usuario el precio.`;
          case "cost_required":
            return `error: cost_required — falta el costo unitario para ${result.error.sku}. Pregunta al usuario el costo.`;
          case "supplier_required":
            return `error: supplier_required — falta el proveedor para este ${args.reason}. Pregunta al usuario y resuelve con resolveSupplier.`;
          case "supplier_not_found":
            return `error: no se encontró el proveedor ${result.error.supplierId} en esta organización`;
          case "unknown":
            return `error: ${result.error.message}`;
          default:
            return `error: ${result.error.kind}`;
        }
      }

      const r = result.row;
      const sign = r.delta > 0 ? "+" : "";
      return `movimiento registrado: ${r.sku} ${sign}${r.delta} (${REASON_ES[r.reason]}) — id=${r.id}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
