import type { AgentInputItem } from "@openai/agents";
import { z } from "zod";
import { env } from "../env.js";
import type { Locale } from "../prompts/system.js";

const SUMMARY_MODEL = "gpt-5-nano";
const SUMMARY_MAX_CHARS = 280;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const ChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
});

function projectItemForSummary(item: AgentInputItem): string {
  const raw = item as unknown as {
    type?: string;
    role?: string;
    content?: unknown;
    name?: string;
    arguments?: string;
    output?: unknown;
  };
  if (raw.type === "function_call") {
    return `tool_call ${raw.name ?? "?"}(${raw.arguments ?? ""})`;
  }
  if (raw.type === "function_call_result") {
    const out =
      typeof raw.output === "string"
        ? raw.output
        : JSON.stringify(raw.output ?? "");
    return `tool_result ${raw.name ?? "?"} -> ${out.slice(0, 400)}`;
  }
  if (raw.role && Array.isArray(raw.content)) {
    const text = raw.content
      .map((c: unknown) => {
        const cc = c as { type?: string; text?: string };
        return typeof cc.text === "string" ? cc.text : "";
      })
      .filter(Boolean)
      .join(" ");
    return `${raw.role}: ${text}`;
  }
  return `${raw.type ?? "item"}`;
}

function locDirective(locale: Locale): string {
  return locale === "en-US"
    ? "Write the summary in English."
    : "Write the summary in neutral Mexican Spanish (es-MX).";
}

export async function summarizeForConversation(
  olderItems: AgentInputItem[],
  priorSummary: string | null,
  locale: Locale,
): Promise<string> {
  const transcript = olderItems.map(projectItemForSummary).join("\n");
  const system = [
    "You are summarizing older turns of a conversation between a user and an inventory assistant.",
    `Compress into <= ${SUMMARY_MAX_CHARS} characters.`,
    "Prioritize: what the user asked, decisions made, entities touched (products/suppliers/movements by name).",
    "If a prior summary is provided, MERGE it with the new transcript into a single coherent summary; do not list them separately.",
    locDirective(locale),
    "Output the summary text only — no preface, no quotes, no markdown.",
  ].join(" ");

  const userParts: string[] = [];
  if (priorSummary) userParts.push(`Prior summary:\n${priorSummary}`);
  userParts.push(`Newly dropped turns:\n${transcript}`);

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userParts.join("\n\n") },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`summary http ${res.status}: ${await res.text()}`);
  }
  const json = ChatResponseSchema.parse(await res.json());
  const text = json.choices[0]!.message.content ?? "";
  return text.trim().slice(0, SUMMARY_MAX_CHARS);
}
