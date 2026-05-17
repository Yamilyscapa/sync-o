import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  listLowStock,
  listProducts,
  listStock,
} from "../../db/products/reads.js";

export const listProductsTool = tool({
  name: "listProducts",
  description:
    "List products in the caller's organization, ordered by SKU. Returns sku, name, quantity, price_cents, currency, is_active. Use for catalog browsing. Organization comes from context — never ask the user.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    cursor: z
      .string()
      .nullable()
      .describe("Last sku from previous page, or null for first page"),
    activeOnly: z
      .boolean()
      .describe("If true, only return is_active=true rows"),
  }),
  execute: async ({ limit, cursor, activeOnly }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listProducts(ctx.supabase, ctx.organizationId, {
        limit,
        cursor: cursor ?? undefined,
        activeOnly,
      });
      return JSON.stringify({ rows, nextCursor: rows.at(-1)?.sku ?? null });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const listStockTool = tool({
  name: "listStock",
  description:
    "List products ordered by stock quantity. Use to answer 'what has the most/least stock'. Returns sku, name, quantity. Organization comes from context.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    order: z
      .enum(["asc", "desc"])
      .describe("'desc' = highest stock first, 'asc' = lowest first"),
  }),
  execute: async ({ limit, order }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listStock(ctx.supabase, ctx.organizationId, {
        limit,
        order,
      });
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const listLowStockTool = tool({
  name: "listLowStock",
  description:
    "List products with quantity <= threshold, ascending by quantity. Use for replenishment / 'what is running low'. Threshold is required — never assume a default. Organization comes from context.",
  parameters: z.object({
    threshold: z
      .number()
      .nonnegative()
      .describe("Inclusive upper bound on quantity"),
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
  }),
  execute: async ({ threshold, limit }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listLowStock(
        ctx.supabase,
        ctx.organizationId,
        threshold,
        limit,
      );
      return JSON.stringify({ rows, threshold });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
