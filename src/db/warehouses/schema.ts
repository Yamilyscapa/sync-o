import { z } from "zod";

export const WAREHOUSE_CODE_REGEX = /^[A-Z0-9-]{2,16}$/;

export const WarehouseSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  code: z.string(),
  location: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Warehouse = z.infer<typeof WarehouseSchema>;

export const WarehouseWriteInputSchema = z.object({
  name: z.string().min(1),
  code: z.string().regex(WAREHOUSE_CODE_REGEX),
  location: z.string().nullable().optional(),
});
export type WarehouseWriteInput = z.infer<typeof WarehouseWriteInputSchema>;

export const WarehousePatchSchema = WarehouseWriteInputSchema.partial().extend({
  is_active: z.boolean().optional(),
});
export type WarehousePatch = z.infer<typeof WarehousePatchSchema>;

export const WarehouseCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  is_active: z.boolean(),
});
export type WarehouseCandidate = z.infer<typeof WarehouseCandidateSchema>;

export type WarehouseWriteError =
  | { kind: "duplicate_name"; name: string }
  | { kind: "duplicate_code"; code: string }
  | { kind: "not_found"; warehouseId: string }
  | { kind: "warehouse_in_use"; message: string }
  | { kind: "cross_org"; message: string }
  | { kind: "invalid_code"; code: string }
  | { kind: "unknown"; message: string };
