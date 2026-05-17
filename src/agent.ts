import { Agent, run } from "@openai/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { systemPrompt } from "./prompts/system.js";
import { tools } from "./tools/index.js";
import { supabase } from "./supabase.js";

export type AgentContext = {
  userId: string;
  organizationId?: string;
  supabase: SupabaseClient;
};

export const buildAgent = () =>
  new Agent<AgentContext>({
    name: "sync-o",
    instructions: systemPrompt,
    model: "gpt-4o-mini",
    tools,
  });


export const runAgent = async (input: string, context: AgentContext) => {
  return await run(buildAgent(), input, { context: context as AgentContext });
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
];

for (const p of prompts) {
  const r = await runAgent(p, ctx);
  console.log(`Q: ${p}`);
  console.log(`A: ${r.finalOutput}\n`);
}