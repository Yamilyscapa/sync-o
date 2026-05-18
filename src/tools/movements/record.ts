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
    "Register a stock movement (intake, sale, adjustment, loss, transfer, reversal, initial). Human-in-the-loop: the runtime interrupts this call so the user can approve or reject before execution. Resolve any non-canonical product reference via `resolveProduct` BEFORE calling this. SKU must match ^[A-Z]{2,5}-\\d{3,}$. `delta` is signed (positive = add, negative = remove); must be non-zero. The organization and actor are taken from server-side context.",
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
      });

      if (!result.ok) {
        switch (result.error.kind) {
          case "product_not_found":
            return `error: no se encontró el producto con SKU ${result.error.sku} en esta organización`;
          case "negative_stock":
            return `error: el movimiento dejaría el stock en negativo (${result.error.message})`;
          case "cross_org":
            return `error: el producto pertenece a otra organización`;
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
