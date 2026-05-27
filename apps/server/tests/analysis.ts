/**
 * Analysis sub-agent test suite.
 *
 * Runs against real Supabase + real OpenAI. Service-role bypasses RLS.
 * Each test logs PASS/FAIL to stdout AND tests/runs/<ts>/ — summary.log,
 * transcript.log (U:/A:), per-test NN-<slug>.log.
 *
 * What's covered (the sub-agent itself + main agent's routing into it):
 *   1. Routing — replenishment prompt invokes `analyze` (main agent's history).
 *   2. Routing — sales-trend prompt invokes `analyze`.
 *   3. Routing — margin prompt invokes `analyze`.
 *   4. Routing — supplier-performance prompt invokes `analyze`.
 *   5. Anti-routing — direct stock lookup MUST NOT invoke `analyze`; it calls
 *      `readStockBySku` / `resolveProduct` instead.
 *   6. Read-only contract — `analyze` runs MUST be `final` (no
 *      awaiting_approval), since the sub-agent has no write tools.
 *   7. Output shape — sub-agent reply contains at least one quantitative
 *      token (digit, %, $MXN, "días", "unidades") to enforce the hard-data
 *      mandate from src/prompts/analysis.ts.
 *
 * NOTE: The sub-agent's *internal* tool calls (resolveProduct, listLowStock,
 * etc.) are not persisted in the parent conversation; agent-as-tool
 * encapsulates them. We assert at the parent boundary instead.
 *
 * Cleanup: created conversations are deleted at end so reruns stay clean.
 */

import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentContext, type AgentRunOutput } from "../src/agent.js";
import { supabase } from "../src/supabase.js";
import { createConversation } from "../src/db/conversations/writes.js";
import { loadConversationForAgent } from "../src/db/conversations/reads.js";

const CTX: AgentContext = {
  userId: "6ee2e332-c8cc-4dec-b353-7cc511376dc3",
  organizationId: "65a88725-aa99-4e0f-b079-cab78725b87b",
  useServiceRole: true,
};

// ---- run-dir + logging setup --------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(here, "runs", `analysis-${stamp}`);
mkdirSync(runDir, { recursive: true });

const summary = createWriteStream(join(runDir, "summary.log"));
const transcript = createWriteStream(join(runDir, "transcript.log"));
const origLog = console.log;
let currentTestStream: ReturnType<typeof createWriteStream> | null = null;

console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  origLog(line);
  summary.write(line + "\n");
  if (currentTestStream) currentTestStream.write(line + "\n");
  if (line.startsWith("U: ") || line.startsWith("A: ")) {
    transcript.write(line + "\n\n");
  }
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

let testIdx = 0;
let failures = 0;
const createdConversationIds: string[] = [];

function pass(name: string, note?: string) {
  console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
}
function fail(name: string, reason: string) {
  failures++;
  console.log(`FAIL ${name} — ${reason}`);
}

async function test(name: string, fn: () => Promise<void>) {
  testIdx++;
  const idx = String(testIdx).padStart(2, "0");
  const file = join(runDir, `${idx}-${slug(name)}.log`);
  currentTestStream = createWriteStream(file);
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (e) {
    fail(name, (e as Error).message ?? String(e));
  } finally {
    currentTestStream.end();
    currentTestStream = null;
  }
}

// ---- helpers ------------------------------------------------------------

async function loggedRun(input: string, ctx: AgentContext): Promise<AgentRunOutput> {
  console.log(`U: ${input}`);
  const out = await runAgent(input, ctx);
  if (out.kind === "final") {
    console.log(`A: ${out.output ?? "(no final output)"}`);
  } else {
    console.log(
      `A: [awaiting_approval ${out.approvals.length}] ${out.approvals
        .map((a) => a.toolName)
        .join(", ")}`,
    );
  }
  return out;
}

type FunctionCallPayload = { type?: string; name?: string };

async function toolCallsFor(conversationId: string): Promise<string[]> {
  const loaded = await loadConversationForAgent(supabase, conversationId);
  if (!loaded) return [];
  return loaded.messages
    .map((m) => m.payload as FunctionCallPayload | null)
    .filter((p): p is FunctionCallPayload => !!p && p.type === "function_call")
    .map((p) => p.name ?? "");
}

const QUANT_RE = /\d|%|\$|MXN|d[ií]as|unidades|pesos/i;

// Hard fails: literal English phrases that should never appear in es-MX output.
const ENGLISH_LEAK_RE =
  /top movers?|dead stock|slow stock|executive summary|\blead times?\b|\bintakes?\b/i;

// Hard fails: follow-up / clarifying-question / trailing-offer patterns.
const FOLLOWUP_RE =
  /elige (una opci[oó]n|entre)|¿qu[eé] prefieres\??|¿algo m[aá]s\??|¿quieres que|si quieres\b|dime (el|qu[eé]|cu[aá]l)|lo preparo|puedo ampliar/i;

// Soft warnings: corporate scaffolding labels. Logged, not failed.
const CORPORATE_HEADER_RE =
  /resumen ejecutivo|resumen principal|limitaciones importantes|limitaciones y datos faltantes|observaciones generales/i;

function checkToneGuards(testName: string, text: string): boolean {
  let ok = true;
  const leak = text.match(ENGLISH_LEAK_RE);
  if (leak) {
    fail(`${testName}.english-leak`, `English jargon in es-MX output: "${leak[0]}"`);
    ok = false;
  }
  const fu = text.match(FOLLOWUP_RE);
  if (fu) {
    fail(`${testName}.follow-up`, `sub-agent asked a follow-up: "${fu[0]}"`);
    ok = false;
  }
  const corp = text.match(CORPORATE_HEADER_RE);
  if (corp) {
    console.log(`  WARN ${testName}.corporate-header — soft warning: "${corp[0]}"`);
  }
  return ok;
}

async function freshConversation(): Promise<string> {
  const conv = await createConversation(supabase, {
    organizationId: CTX.organizationId!,
    userId: CTX.userId,
    firstUserInput: "_seed_",
  });
  createdConversationIds.push(conv.id);
  return conv.id;
}

async function assertAnalyzeRouting(testName: string, prompt: string) {
  const conversationId = await freshConversation();
  const out = await loggedRun(prompt, { ...CTX, conversationId });

  if (out.kind !== "final") {
    return fail(`${testName}.kind`, `expected final (read-only), got ${out.kind}`);
  }
  const calls = await toolCallsFor(conversationId);
  console.log(`  tool_calls: [${calls.join(", ")}]`);

  if (!calls.includes("analyze")) {
    return fail(`${testName}.routing`, `expected 'analyze' in tool_calls, got [${calls.join(", ")}]`);
  }
  const text = out.output ?? "";
  if (!QUANT_RE.test(text)) {
    return fail(
      `${testName}.quant`,
      `output lacks quantitative token (digit/%/$/días/unidades): ${text.slice(0, 120)}…`,
    );
  }
  if (!checkToneGuards(testName, text)) return;
  pass(`${testName}`, `analyze invoked, output has numbers, tone OK`);
}

// ---- 1-4. routing tests --------------------------------------------------

await test("1 routing — replenishment", async () => {
  await assertAnalyzeRouting("1", "¿Qué productos debo reponer?");
});

await test("2 routing — sales trends", async () => {
  await assertAnalyzeRouting("2", "¿Cómo van las ventas de los últimos 30 días?");
});

await test("3 routing — margin", async () => {
  await assertAnalyzeRouting("3", "¿Cómo está el margen de los tornillos?");
});

await test("4 routing — supplier performance", async () => {
  await assertAnalyzeRouting(
    "4",
    "¿Cómo va el desempeño de Ferretería del Norte en los últimos 30 días?",
  );
});

// ---- 5. anti-routing: direct lookup must not invoke analyze --------------

await test("5 anti-routing — direct stock lookup", async () => {
  const conversationId = await freshConversation();
  const out = await loggedRun("¿Cuánto stock hay de IND-001?", {
    ...CTX,
    conversationId,
  });
  if (out.kind !== "final") {
    return fail("5.kind", `expected final, got ${out.kind}`);
  }
  const calls = await toolCallsFor(conversationId);
  console.log(`  tool_calls: [${calls.join(", ")}]`);

  if (calls.includes("analyze")) {
    return fail("5.routing", `direct lookup unexpectedly invoked analyze: [${calls.join(", ")}]`);
  }
  const hitDirect = calls.some(
    (n) => n === "readStockBySku" || n === "resolveProduct" || n === "listStock",
  );
  if (!hitDirect) {
    return fail(
      "5.direct-tool",
      `expected readStockBySku / resolveProduct / listStock; got [${calls.join(", ")}]`,
    );
  }
  pass("5.direct-lookup", "analyze NOT invoked; direct read tool used");
});

// ---- 6. read-only contract -----------------------------------------------

await test("6 read-only contract — analyze never awaits approval", async () => {
  const conversationId = await freshConversation();
  const out = await loggedRun(
    "Dame un análisis completo: qué reponer, márgenes y desempeño de proveedores.",
    { ...CTX, conversationId },
  );
  if (out.kind === "awaiting_approval") {
    return fail(
      "6.hitl",
      `analyze run produced awaiting_approval (sub-agent has no write tools): ${out.approvals
        .map((a) => a.toolName)
        .join(", ")}`,
    );
  }
  const calls = await toolCallsFor(conversationId);
  if (!calls.includes("analyze")) {
    return fail("6.routing", `expected analyze, got [${calls.join(", ")}]`);
  }
  const text = out.kind === "final" ? out.output ?? "" : "";
  if (!checkToneGuards("6", text)) return;
  pass("6.read-only", "no HITL, analyze invoked, tone OK");
});

// ---- cleanup -------------------------------------------------------------

console.log("\n=== cleanup ===");
for (const id of createdConversationIds) {
  const { error } = await supabase.from("conversations").delete().eq("id", id);
  if (error) console.log(`  delete ${id.slice(0, 8)}…: ${error.message}`);
}
console.log(`deleted ${createdConversationIds.length} conversations`);
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);

summary.end();
transcript.end();
process.exit(failures === 0 ? 0 : 1);
