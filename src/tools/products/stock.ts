import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { getStockBySku } from "../../db/products/reads.js";
import { SKU_REGEX_DESC } from "../../db/products/sku.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku } from "../_guards.js";

export const readStockBySku = tool({
  name: "readStockBySku",
  description:
    "Read the current stock quantity of a product in the caller's organization, looked up by canonical SKU. Only accepts SKUs matching ^[A-Z]{2,5}-\\d{3,}$. For natural-language references, call `resolveProduct` first. The organization is taken from context — never ask the user for it.",
  parameters: z.object({
    sku: z
      .string()
      .describe(
        `${SKU_REGEX_DESC}. MUST be a canonical SKU — if the user referenced the product by name, call resolveProduct FIRST.`,
      ),
  }),
  execute: async ({ sku }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(sku);
    if (skuErr) return skuErr;

    try {
      const row = await getStockBySku(getSupabaseFromContext(ctx), ctx.organizationId, sku);
      if (!row) return `no product with sku ${sku} in this organization`;
      return `stock(${row.sku}) = ${row.quantity} (${row.name})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
