import { Agent, run } from "@openai/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSystemPrompt, DEFAULT_LOCALE, type Locale } from "./prompts/system.js";
import { tools } from "./tools/index.js";
import { supabase } from "./supabase.js";

export type AgentContext = {
  userId: string;
  organizationId?: string;
  locale?: Locale;
  supabase: SupabaseClient;
};

export const buildAgent = (locale: Locale = DEFAULT_LOCALE) =>
  new Agent<AgentContext>({
    name: "sync-o",
    instructions: buildSystemPrompt(locale),
    model: "gpt-4o-mini",
    tools,
  });


export const runAgent = async (input: string, context: AgentContext) => {
  const agent = buildAgent(context.locale ?? DEFAULT_LOCALE);
  return await run(agent, input, { context });
};

// ! Debug harness: bypasses RLS via service-role client. Remove before production.
const ctx: AgentContext = {
  userId: "6ee2e332-c8cc-4dec-b353-7cc511376dc3",
  organizationId: "65a88725-aa99-4e0f-b079-cab78725b87b",
  supabase,
};

const prompts = [
  "What is the stock of IND-001?",
  "How many tornillos do we have?",
  "¿Cuál es el stock de aceite de oliva actualmente?",
  "List the first 5 products in our catalog.",
  "Which 3 products have the most stock?",
  "Which 3 products have the least stock?",
  "Show me products with stock at or below 20.",
  "¿Qué productos están por debajo de 50 unidades?",
];

for (const p of prompts) {
  const r = await runAgent(p, ctx);
  console.log(`Q: ${p}`);
  console.log(`A: ${r.finalOutput}\n`);
}