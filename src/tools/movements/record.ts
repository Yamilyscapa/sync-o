import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { MovementReasonSchema } from "../../db/movements/schema.js";
import { recordMovement } from "../../db/movements/writes.js";
import { SKU_REGEX, SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";

export const recordStockMovement = tool({
  name: "recordStockMovement",
  needsApproval: true,
  description:
    "Register a stock movement (intake, sale, adjustment, loss, transfer, reversal, initial). Human-in-the-loop: the runtime interrupts this call so the user can approve or reject before execution.\n\n" +
    "Resolve any non-canonical product reference via `resolveProduct` BEFORE calling this. SKU must match ^[A-Z]{2,5}-\\d{3,}$. `delta` is signed (positive = add, negative = remove); must be non-zero. The organization and actor are taken from server-side context.\n\n" +
    "Required parameters by reason:\n" +
    "- intake / initial: `supplierId` is REQUIRED — resolve via `resolveSupplier` first, never invent UUIDs. `unitCostCents` may be null for intake — the tool will default to the last known cost from this supplier; for `initial` it MUST be supplied.\n" +
    "- sale: `unitPriceCents` may be null — the tool will default to the most recent sale price for this SKU, then fall back to the catalog `price_cents`.\n" +
    "- adjustment / loss / transfer: `supplierId`, `unitCostCents`, `unitPriceCents` MUST all be null.\n" +
    "- reversal: pass nulls for `supplierId`, `unitCostCents`, `unitPriceCents`; the trigger inherits them from the original movement.\n\n" +
    "DO NOT ask the user for price/cost in chat when the tool can default. Pass null and let the HITL approval surface the defaulted value. ONLY ask the user when the tool returns `price_required`, `cost_required`, or `supplier_required`.",
  parameters: z.object({
    sku: z.string().regex(SKU_REGEX, SKU_REGEX_DESC).describe(SKU_REGEX_DESC),
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
      .uuid()
      .nullable()
      .describe("UUID of the movement being reversed; required if reason='reversal', else null"),
    supplierId: z
      .string()
      .uuid()
      .nullable()
      .describe(
        "Supplier UUID. REQUIRED for intake/initial (resolve via `resolveSupplier` if user gave a name). Null for sale/adjustment/loss/transfer. Null for reversal (trigger inherits from original).",
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
      return `movimiento registrado: ${r.sku} ${sign}${r.delta} (${r.reason}) — id=${r.id}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
