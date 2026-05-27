import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import type { WarehouseWriteError } from "../../db/warehouses/schema.js";
import { WAREHOUSE_CODE_REGEX } from "../../db/warehouses/schema.js";
import {
  createWarehouse,
  deactivateWarehouse,
  updateWarehouse,
} from "../../db/warehouses/writes.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardUuid } from "../_guards.js";

export const WAREHOUSE_ID_DESC =
  "Warehouse UUID. If the user gave a name or code, call resolveWarehouse FIRST and use the returned candidates[0].id.";
export const WAREHOUSE_RESOLVER_HINT = `resolveWarehouse({ query: "<name or code>" })`;

const CODE_DESC =
  "Short uppercase identifier, 2-16 chars matching ^[A-Z0-9-]+$ (e.g. MAIN, CDMX-01). Used by the agent and humans to refer to the warehouse.";

export function translateWarehouseError(e: WarehouseWriteError): string {
  switch (e.kind) {
    case "duplicate_name":
      return `error: ya existe una bodega llamada "${e.name}" en esta organización`;
    case "duplicate_code":
      return `error: ya existe una bodega con código "${e.code}" en esta organización`;
    case "invalid_code":
      return `error: el código "${e.code}" no es válido. Debe tener 2-16 caracteres en mayúsculas, dígitos o guiones (ejemplo: MAIN, CDMX-01)`;
    case "not_found":
      return `error: no encontré la bodega ${e.warehouseId} en esta organización`;
    case "warehouse_in_use":
      return `error: no se puede borrar esta bodega porque tiene movimientos o stock asignado. Considera desactivarla en lugar de borrarla.`;
    case "cross_org":
      return `error: la bodega pertenece a otra organización`;
    case "unknown":
      return `error: ${e.message}`;
    default: {
      const _exhaustive: never = e;
      return `error: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

export const createWarehouseTool = tool({
  name: "createWarehouse",
  needsApproval: true,
  description:
    "Register a new warehouse (bodega) in the caller's organization. Human-in-the-loop. `name` and `code` are required; `location` optional. `code` is uppercased server-side. Do NOT fabricate any field. Do NOT ask the user for optional fields they did not mention.",
  parameters: z.object({
    name: z.string().min(1).describe("Warehouse display name (e.g. 'Bodega Sur')"),
    code: z.string().regex(WAREHOUSE_CODE_REGEX).describe(CODE_DESC),
    location: z
      .string()
      .nullable()
      .describe("Free-text address or location"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";
    try {
      const result = await createWarehouse(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        {
          name: args.name,
          code: args.code,
          location: args.location,
        },
      );
      if (!result.ok) return translateWarehouseError(result.error);
      return `bodega creada: ${result.row.name} (código ${result.row.code}, id=${result.row.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const updateWarehouseTool = tool({
  name: "updateWarehouse",
  needsApproval: true,
  description:
    "Update fields on an existing warehouse. Provide ONLY the fields the user asked to change. Human-in-the-loop.",
  parameters: z.object({
    warehouseId: z.string().describe(WAREHOUSE_ID_DESC),
    name: z.string().nullable().describe("New name, or null to leave unchanged"),
    code: z.string().nullable().describe(`New code (will be uppercased), or null to leave unchanged. ${CODE_DESC}`),
    location: z.string().nullable().describe("New location, or null to leave unchanged"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const idErr = guardUuid(args.warehouseId, "warehouseId", WAREHOUSE_RESOLVER_HINT);
    if (idErr) return idErr;

    const patch: Record<string, unknown> = {};
    if (args.name != null) patch.name = args.name;
    if (args.code != null) patch.code = args.code;
    if (args.location != null) patch.location = args.location;

    try {
      const result = await updateWarehouse(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        args.warehouseId,
        patch,
      );
      if (!result.ok) return translateWarehouseError(result.error);
      return `bodega actualizada: ${result.row.name} (código ${result.row.code}, id=${result.row.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const deactivateWarehouseTool = tool({
  name: "deactivateWarehouse",
  needsApproval: true,
  description:
    "Soft-delete a warehouse by setting is_active=false. The warehouse is hidden from default lists but historical movements and stock rows are preserved. Prefer this over hard deletion. Human-in-the-loop.",
  parameters: z.object({
    warehouseId: z.string().describe(WAREHOUSE_ID_DESC),
  }),
  execute: async ({ warehouseId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const idErr = guardUuid(warehouseId, "warehouseId", WAREHOUSE_RESOLVER_HINT);
    if (idErr) return idErr;

    try {
      const result = await deactivateWarehouse(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        warehouseId,
      );
      if (!result.ok) return translateWarehouseError(result.error);
      return `bodega desactivada: ${result.row.name} (id=${result.row.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
