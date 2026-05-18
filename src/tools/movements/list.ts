import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import {
  getMovementsBySku,
  listMovements,
} from "../../db/movements/reads.js";
import { MovementReasonSchema } from "../../db/movements/schema.js";
import { SKU_REGEX, SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";

export const listStockMovements = tool({
  name: "listStockMovements",
  description:
    "List recent stock movements for the organization, newest first. Optionally filter by `reason` or by ISO datetime `sinceIso`. Read-only. Organization comes from context.",
  parameters: z.object({
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
    reason: MovementReasonSchema.nullable().describe(
      "Optional reason filter, or null for all",
    ),
    sinceIso: z
      .string()
      .nullable()
      .describe(
        "Optional ISO 8601 datetime lower bound (e.g. '2026-05-17T00:00:00Z'), or null",
      ),
  }),
  execute: async ({ limit, reason, sinceIso }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await listMovements(getSupabaseFromContext(ctx), ctx.organizationId, {
        limit,
        reason: reason ?? undefined,
        sinceIso: sinceIso ?? undefined,
      });
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const getStockHistory = tool({
  name: "getStockHistory",
  description:
    "Return the movement history of a single product by canonical SKU, newest first. Read-only. SKU must match ^[A-Z]{2,5}-\\d{3,}$ — resolve natural-language references via `resolveProduct` first.",
  parameters: z.object({
    sku: z.string().regex(SKU_REGEX, SKU_REGEX_DESC).describe(SKU_REGEX_DESC),
    limit: z.number().int().min(1).max(100).describe("Page size, 1-100"),
  }),
  execute: async ({ sku, limit }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const rows = await getMovementsBySku(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        sku,
        limit,
      );
      return JSON.stringify({ rows });
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
