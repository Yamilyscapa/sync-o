import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";

export const readStock = tool({
  name: "readStock",
  description: "Read the current stock quantity of a product by id.",
  parameters: z.object({
    productId: z.string().uuid().describe("Product id (uuid)"),
  }),
  execute: async ({ productId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    const { data, error } = await ctx.supabase
      .from("product_stock")
      .select("quantity")
      .eq("product_id", productId)
      .maybeSingle();
    if (error) return `error: ${error.message}`;
    if (!data) return `no stock row for product ${productId}`;
    return `stock(${productId}) = ${data.quantity}`;
  },
});
