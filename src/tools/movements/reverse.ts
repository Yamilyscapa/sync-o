import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { reverseMovement } from "../../db/movements/reverse.js";
import { getSupabaseFromContext } from "../../supabase.js";

export const reverseStockMovement = tool({
  name: "reverseStockMovement",
  needsApproval: true,
  description:
    "Reverse a previously recorded stock movement by posting a compensating ledger row (delta = -original.delta, reason = 'reversal', related_movement_id = original.id). Human-in-the-loop: the runtime interrupts this call so the user can approve or reject before execution. USE THIS — not a new sale/adjustment/loss — when the user signals the original movement was a mistake ('fue un error', 'me equivoqué', 'cancela el último', 'deshazlo', 'reversa eso', 'borra ese movimiento'). For LEGITIMATE corrections where the original was real but a new change is needed ('ahora son 30 en vez de 3 más'), register a NEW movement instead. If the user doesn't supply a movement id, look one up via `listStockMovements` or `getStockHistory` and confirm with the user — never invent UUIDs. Each original movement can be reversed at most once; a reversal cannot itself be reversed.",
  parameters: z.object({
    movementId: z
      .string()
      .uuid()
      .describe("UUID of the original movement to reverse"),
    note: z
      .string()
      .nullable()
      .describe("Optional Spanish note explaining why the reversal was needed"),
  }),
  execute: async ({ movementId, note }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const result = await reverseMovement(getSupabaseFromContext(ctx), {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        movementId,
        note,
      });

      if (!result.ok) {
        switch (result.error.kind) {
          case "reversal_target_missing":
            return `error: no encontré el movimiento ${result.error.movementId} en esta organización`;
          case "already_reversed":
            return `error: ese movimiento ya fue reversado previamente (reversa id=${result.error.reversalId ?? "desconocido"})`;
          case "reversal_of_reversal":
            return "error: no se puede reversar una reversa. Si el ajuste sigue mal, registra un movimiento nuevo (sale, adjustment, etc.)";
          case "reversal_delta_mismatch":
            return `error: inconsistencia interna al calcular la reversa (${result.error.message})`;
          case "negative_stock":
            return "error: la reversa dejaría el stock en negativo. Revisa los movimientos posteriores antes de intentar deshacer este ingreso";
          case "cross_org":
            return "error: el movimiento pertenece a otra organización";
          case "product_not_found":
            return "error: el producto asociado al movimiento ya no existe";
          default:
            return `error: ${result.error.kind}`;
        }
      }

      const { reversal, original } = result;
      const origSign = original.delta > 0 ? "+" : "";
      const revSign = reversal.delta > 0 ? "+" : "";
      return `reversa registrada: ${original.sku} movimiento original ${origSign}${original.delta} (${original.reason}, id=${original.id}) anulado con ${revSign}${reversal.delta} (id=${reversal.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
