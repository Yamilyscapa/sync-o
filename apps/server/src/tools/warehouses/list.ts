import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  getWarehouseById,
  getWarehouseSaturation,
  listWarehouses,
  resolveWarehouse,
} from "../../db/warehouses/reads.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardUuid } from "../_guards.js";
import { WAREHOUSE_ID_DESC, WAREHOUSE_RESOLVER_HINT } from "./write.js";

export const listWarehousesTool = tool({
  name: "listWarehouses",
  description:
    "List warehouses (bodegas) in the caller's organization, alphabetical by name. Returns id, name, code, location, is_active. Organization comes from context.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    cursor: z
      .string()
      .nullable()
      .describe("Last name from previous page, or null for first page"),
    activeOnly: z.boolean().describe("If true, only return is_active=true rows"),
  }),
  execute: async ({ limit, cursor, activeOnly }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listWarehouses(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        { limit, cursor: cursor ?? undefined, activeOnly },
      );
      return JSON.stringify({ rows, nextCursor: rows.at(-1)?.name ?? null });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const getWarehouseTool = tool({
  name: "getWarehouse",
  description:
    "Fetch a single warehouse by UUID. Returns full warehouse row or null if not found.",
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
      const row = await getWarehouseById(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        warehouseId,
      );
      return JSON.stringify({ row });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const getWarehouseSaturationTool = tool({
  name: "getWarehouseSaturation",
  description:
    "Per-warehouse aggregate snapshot: SKU count with stock, total units, estimated value (Σ qty × preferred-supplier last cost, in cents). Single RPC — cheap. Use for 'cómo está repartido el inventario', '¿qué bodega está más cargada?', or any cross-bodega load comparison.",
  parameters: z.object({}),
  execute: async (_args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await getWarehouseSaturation(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
      );
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const resolveWarehouseTool = tool({
  name: "resolveWarehouse",
  description:
    "Resolve a natural-language warehouse reference (name or code) to a canonical warehouse UUID in the caller's organization. Returns candidates and an `ambiguous` flag. Call this whenever the user mentions a bodega by name or short code. If `ambiguous` is true, ask the user to pick before calling any warehouse-keyed tool. NEVER fabricate a warehouse UUID. This is a CHEAP read tool — call it freely. Skipping causes the next tool to fail with warehouseId_not_resolved.",
  parameters: z.object({
    query: z.string().min(1).describe("Warehouse name, code, or partial text"),
    limit: z.number().int().min(1).max(20).describe("Max candidates (1-20)"),
  }),
  execute: async ({ query, limit }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const res = await resolveWarehouse(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        query,
        limit,
      );
      return JSON.stringify(res);
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
