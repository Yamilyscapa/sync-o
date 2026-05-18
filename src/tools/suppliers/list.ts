import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  getSupplierById,
  listProductSuppliers,
  listSuppliers,
  listSupplierProducts,
  resolveSupplier,
} from "../../db/suppliers/reads.js";
import { SKU_REGEX, SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";

export const listSuppliersTool = tool({
  name: "listSuppliers",
  description:
    "List suppliers in the caller's organization, alphabetical by name. Returns id, name, contact, lead time, payment terms, currency, is_active. Use for catalog browsing of vendors. Organization comes from context.",
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
      const rows = await listSuppliers(
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

export const getSupplierTool = tool({
  name: "getSupplier",
  description:
    "Fetch a single supplier by UUID. Returns full supplier row or null if not found in caller's organization.",
  parameters: z.object({
    supplierId: z.string().uuid().describe("Supplier UUID"),
  }),
  execute: async ({ supplierId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const row = await getSupplierById(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        supplierId,
      );
      return JSON.stringify({ row });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const resolveSupplierTool = tool({
  name: "resolveSupplier",
  description:
    "Resolve a natural-language supplier reference (name or partial) to a canonical supplier UUID in the caller's organization. Returns candidates and an `ambiguous` flag. Call this whenever the user mentions a supplier by name. If `ambiguous` is true, ask the user to pick before calling any supplier-keyed tool. NEVER fabricate a supplier UUID.",
  parameters: z.object({
    query: z.string().min(1).describe("Supplier name or partial text"),
    limit: z.number().int().min(1).max(20).describe("Max candidates (1-20)"),
  }),
  execute: async ({ query, limit }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const res = await resolveSupplier(
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

export const listProductSuppliersTool = tool({
  name: "listProductSuppliers",
  description:
    "List suppliers that supply a given product (by SKU). Returns supplier name, supplier_sku, last unit cost, last purchased timestamp, lead time, preferred flag. Use to answer 'who supplies X' / '¿cuánto pagamos por X la última vez?'.",
  parameters: z.object({
    sku: z
      .string()
      .regex(SKU_REGEX, SKU_REGEX_DESC)
      .describe(SKU_REGEX_DESC),
  }),
  execute: async ({ sku }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listProductSuppliers(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        sku,
      );
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const listSupplierProductsTool = tool({
  name: "listSupplierProducts",
  description:
    "List products supplied by a given supplier (by UUID). Returns product sku, name, supplier_sku, last cost, lead time, preferred flag.",
  parameters: z.object({
    supplierId: z.string().uuid().describe("Supplier UUID"),
  }),
  execute: async ({ supplierId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listSupplierProducts(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        supplierId,
      );
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
