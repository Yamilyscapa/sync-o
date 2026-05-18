import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { getMovementById } from "../../db/movements/reads.js";
import { MovementReasonSchema } from "../../db/movements/schema.js";
import { getSupabaseFromContext } from "../../supabase.js";

const RecordStockMovementArgsSchema = z.object({
  sku: z.string(),
  delta: z.number(),
  reason: MovementReasonSchema,
  note: z.string().nullable(),
  relatedMovementId: z.string().nullable(),
});

const ReverseStockMovementArgsSchema = z.object({
  movementId: z.string(),
  note: z.string().nullable(),
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

function safeParse(rawArgs: string | undefined): unknown {
  if (!rawArgs) return undefined;
  try {
    return JSON.parse(rawArgs);
  } catch {
    return undefined;
  }
}

/**
 * Build a Spanish (es-MX) approval preview string for a HITL tool call.
 * Async so branches can perform DB lookups (e.g. resolving a movementId
 * into a human-readable description for reversals).
 */
export async function buildApprovalPreview(
  toolName: string,
  rawArgs: string | undefined,
  ctx: AgentContext,
): Promise<string> {
  if (!rawArgs) return `Confirma la operación: ${toolName}`;
  const parsed = safeParse(rawArgs);
  if (parsed === undefined) {
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

  if (toolName === "reverseStockMovement") {
    const result = ReverseStockMovementArgsSchema.safeParse(parsed);
    if (!result.success || !ctx.organizationId) {
      return `Confirma reversar movimiento (parámetros inválidos): ${rawArgs}`;
    }
    const { movementId, note } = result.data;
    try {
      const supabase = getSupabaseFromContext(ctx);
      const original = await getMovementById(supabase, ctx.organizationId, movementId);
      if (!original) {
        return `No encontré el movimiento ${movementId} en esta organización. Si confirmas, la operación fallará.`;
      }
      const sign = original.delta > 0 ? "+" : "";
      const reasonEs = REASON_ES[original.reason];
      const compensating = original.delta > 0 ? `${-original.delta}` : `+${-original.delta}`;
      const when = original.created_at.replace("T", " ").slice(0, 16);
      const noteSuffix = note ? ` Nota: "${note}".` : "";
      return `¿Confirmas reversar el movimiento de ${original.sku} (${original.name}) de ${sign}${original.delta} unidades (${reasonEs}) registrado el ${when}? Quedará anulado con una contra-entrada de ${compensating}.${noteSuffix}`;
    } catch (e) {
      return `Confirma reversar movimiento ${movementId} (no pude leer detalles: ${(e as Error).message}).`;
    }
  }

  return `Confirma la operación: ${toolName} con args ${rawArgs}`;
}
