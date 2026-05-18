import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { resolveProductsByText } from "../../db/products/resolve.js";
import { getSupabaseFromContext } from "../../supabase.js";

export const resolveProduct = tool({
  name: "resolveProduct",
  description:
    "Resolve a natural-language product reference to canonical SKU(s) in the caller's organization. Returns ranked candidates with similarity scores and an `ambiguous` flag. Call this whenever the user references a product by name/description instead of a canonical SKU (regex: ^[A-Z]{2,5}-\\d{3,}$). If `ambiguous` is true, ask the user to disambiguate before calling any SKU-keyed tool.",
  parameters: z.object({
    query: z.string().min(1).describe("Natural-language product reference"),
    limit: z.number().int().min(1).max(20).describe("Max candidates (1-20)"),
  }),
  execute: async ({ query, limit }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    try {
      const res = await resolveProductsByText(getSupabaseFromContext(ctx), ctx.organizationId, query, limit);
      return JSON.stringify(res);
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
