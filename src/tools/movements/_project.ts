import type { MovementReason, MovementWithProductRow } from "../../db/movements/schema.js";

// Tool-boundary projection: translate English enums and snake_case fields to
// user-facing Spanish nouns, and convert cents to pesos. The DB layer stays
// English; only the agent-visible payload is localized. This prevents the
// model from leaking raw enum values like `reason: "sale"` into its replies.

export const REASON_ES: Record<MovementReason, string> = {
  intake: "entrada",
  sale: "venta",
  adjustment: "ajuste",
  loss: "merma",
  transfer: "traslado",
  reversal: "reversa",
  initial: "carga inicial",
};

const shortId = (id: string | null): string | null =>
  id ? id.slice(0, 8) : null;

const centsToPesos = (cents: number | null): number | null =>
  cents == null ? null : cents / 100;

export type ProjectedMovement = {
  id: string;
  id_corto: string | null;
  sku: string;
  producto: string;
  cantidad: number;
  motivo: string;
  fecha: string;
  nota: string | null;
  proveedor: string | null;
  proveedor_id_corto: string | null;
  costo_unitario_mxn: number | null;
  costo_total_mxn: number | null;
  precio_unitario_mxn: number | null;
  ingreso_total_mxn: number | null;
  revierte: string | null;
};

export function projectMovement(r: MovementWithProductRow): ProjectedMovement {
  return {
    id: r.id,
    id_corto: shortId(r.id),
    sku: r.sku,
    producto: r.name,
    cantidad: r.delta,
    motivo: REASON_ES[r.reason],
    fecha: r.created_at,
    nota: r.note,
    proveedor: r.supplier_name,
    proveedor_id_corto: shortId(r.supplier_id),
    costo_unitario_mxn: centsToPesos(r.unit_cost_cents),
    costo_total_mxn: centsToPesos(r.total_cost_cents),
    precio_unitario_mxn: centsToPesos(r.unit_price_cents),
    ingreso_total_mxn: centsToPesos(r.total_revenue_cents),
    revierte: shortId(r.related_movement_id),
  };
}
