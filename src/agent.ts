import { Agent } from "@openai/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { systemPrompt } from "./prompts/system.js";
import { tools } from "./tools/index.js";

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
