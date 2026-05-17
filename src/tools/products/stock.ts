import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { getStockBySku } from "../../db/products/reads.js";
import { SKU_REGEX, SKU_REGEX_DESC } from "../../db/products/sku.js";

export const readStockBySku = tool({
  name: "readStockBySku",
  description:
    "Read the current stock quantity of a product in the caller's organization, looked up by canonical SKU. Only accepts SKUs matching ^[A-Z]{2,5}-\\d{3,}$. For natural-language references, call `resolveProduct` first. The organization is taken from context — never ask the user for it.",
  parameters: z.object({
    sku: z.string().regex(SKU_REGEX, SKU_REGEX_DESC).describe(SKU_REGEX_DESC),
  }),
  execute: async ({ sku }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const row = await getStockBySku(ctx.supabase, ctx.organizationId, sku);
      if (!row) return `no product with sku ${sku} in this organization`;
      return `stock(${row.sku}) = ${row.quantity} (${row.name})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
