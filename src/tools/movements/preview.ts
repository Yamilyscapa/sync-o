import { z } from "zod";
import { MovementReasonSchema } from "../../db/movements/schema.js";

const RecordStockMovementArgsSchema = z.object({
  sku: z.string(),
  delta: z.number(),
  reason: MovementReasonSchema,
  note: z.string().nullable(),
  relatedMovementId: z.string().nullable(),
});

const REASON_ES: Record<z.infer<typeof MovementReasonSchema>, string> = {
  intake: "entrada",
  sale: "venta",
  adjustment: "ajuste",
  loss: "merma",
  transfer: "traslado",
  reversal: "reversa",
  initial: "carga inicial",
};

/**
 * Build a Spanish (es-MX) approval preview string for a HITL tool call.
 * Keyed by tool name. Add a branch per new write tool.
 */
export function buildApprovalPreview(
  toolName: string,
  rawArgs: string | undefined,
): string {
  if (!rawArgs) return `Confirma la operación: ${toolName}`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return `Confirma la operación: ${toolName} (args ilegibles)`;
  }

  if (toolName === "recordStockMovement") {
    const result = RecordStockMovementArgsSchema.safeParse(parsed);
    if (!result.success) {
      return `Confirma registro de movimiento (parámetros inválidos): ${rawArgs}`;
    }
    const { sku, delta, reason, note } = result.data;
    const sign = delta > 0 ? "+" : "";
    const reasonEs = REASON_ES[reason];
    const noteSuffix = note ? `, nota: "${note}"` : "";
    return `¿Confirmas registrar un movimiento de ${sign}${delta} unidades para ${sku} (${reasonEs})${noteSuffix}?`;
  }

  return `Confirma la operación: ${toolName} con args ${rawArgs}`;
}
