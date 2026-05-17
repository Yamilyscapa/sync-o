import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";

const AttributeFilter = z.object({
  key: z.string().describe("attribute key, e.g. 'color', 'brand', 'weight_kg'"),
  value: z.string().describe("string-encoded value to match (numbers/dates compared as strings via jsonb ->>)"),
});

export const searchProducts = tool({
  name: "searchProducts",
  description:
    "Search products in the caller's organization. Supports text match on name/sku and equality filters on standardized attributes (see attribute_definitions).",
  parameters: z.object({
    organizationId: z.string().uuid().describe("Organization id to scope the search to"),
    query: z.string().nullable().describe("Optional substring to match name or sku (case-insensitive). Pass null for no text filter."),
    attributes: z.array(AttributeFilter).describe("Equality filters on attributes (empty array for none)"),
    limit: z.number().int().min(1).max(100).describe("Max rows to return (1-100)"),
  }),
  execute: async ({ organizationId, query, attributes, limit }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";

    let q = ctx.supabase
      .from("products_searchable")
      .select("id, sku, name, price_cents, currency, quantity, attributes")
      .eq("organization_id", organizationId)
      .limit(limit);

    if (query) {
      q = q.or(`name.ilike.%${query}%,sku.ilike.%${query}%`);
    }
    for (const f of attributes) {
      q = q.eq(`attributes->>${f.key}`, f.value);
    }

    const { data, error } = await q;
    if (error) return `error: ${error.message}`;
    return JSON.stringify(data ?? []);
  },
});
