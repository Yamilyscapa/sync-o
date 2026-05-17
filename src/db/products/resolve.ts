import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const ProductCandidateSchema = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.coerce.number(),
  attributes: z.record(z.string(), z.unknown()),
  score: z.coerce.number(),
});
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

export const ResolveResultSchema = z.object({
  candidates: z.array(ProductCandidateSchema),
  ambiguous: z.boolean(),
});
export type ResolveResult = z.infer<typeof ResolveResultSchema>;

const AMBIGUITY_DELTA = 0.10;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;

export async function resolveProductsByText(
  supabase: SupabaseClient,
  organizationId: string,
  query: string,
  limit = 5,
): Promise<ResolveResult> {
  const { data, error } = await supabase.rpc("search_products_by_text", {
    p_org: organizationId,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);

  const candidates = z.array(ProductCandidateSchema).parse(data ?? []);
  const top = candidates[0];
  const second = candidates[1];
  const ambiguous =
    !!top &&
    !!second &&
    top.score < HIGH_CONFIDENCE_THRESHOLD &&
    top.score - second.score < AMBIGUITY_DELTA;

  return ResolveResultSchema.parse({ candidates, ambiguous });
}
