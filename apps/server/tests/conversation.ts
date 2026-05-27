/**
 * Conversation persistence + bounded-context test suite.
 *
 * Runs against the real Supabase + real OpenAI. Service-role client bypasses
 * RLS. Each test logs PASS/FAIL to stdout AND to a per-run directory under
 * tests/runs/<ts>/ — summary.log, transcript.log (U:/A: lines), and one
 * NN-<slug>.log per test.
 *
 * Tests:
 *   1. Multi-turn coherence — server issues conversationId, follow-up turn
 *      uses prior context.
 *   2. Bounded context (unit) — selectWindow caps at HISTORY_WINDOW_ITEMS and
 *      keeps function_call ↔ function_call_result pairs intact.
 *   3. Tool resolution coherence — agent calls resolver before write tool;
 *      persisted history contains the expected tool_call sequence.
 *   4. HITL restart — runAgent yields awaiting_approval, pending_state is
 *      persisted, resumeAgent(null, decisions, { conversationId }) resumes.
 *
 * Cleanup: created conversations are deleted at end so reruns stay clean.
 */

import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInputItem } from "@openai/agents";
import {
  runAgent,
  resumeAgent,
  type AgentContext,
  type AgentRunOutput,
} from "../src/agent.js";
import { supabase } from "../src/supabase.js";
import {
  HISTORY_WINDOW_ITEMS,
  selectWindow,
} from "../src/agent/history.js";
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
const runDir = join(here, "runs", stamp);
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

// ---- agent-call helpers that log U:/A: to transcript --------------------

async function loggedRun(input: string, ctx: AgentContext): Promise<AgentRunOutput> {
  console.log(`U: ${input}`);
  const out = await runAgent(input, ctx);
  logOutput(out);
  return out;
}

async function loggedResume(
  serializedState: string | null,
  decisions: Parameters<typeof resumeAgent>[1],
  ctx: AgentContext,
): Promise<AgentRunOutput> {
  console.log(
    `U: [resume] ${decisions.map((d) => `${d.toolName}:${d.approved ? "approve" : "reject"}`).join(", ")}`,
  );
  const out = await resumeAgent(serializedState, decisions, ctx);
  logOutput(out);
  return out;
}

function logOutput(out: AgentRunOutput) {
  if (out.kind === "final") {
    console.log(`A: ${out.output ?? "(no final output)"}`);
  } else {
    console.log(
      `A: [awaiting_approval ${out.approvals.length}] ${out.approvals
        .map((a) => a.toolName)
        .join(", ")}`,
    );
    for (const a of out.approvals) {
      console.log(`   preview: ${a.preview}`);
    }
  }
}

console.log(`[run] ${stamp} — writing to ${runDir}`);

// ---- 1. multi-turn coherence --------------------------------------------

await test("1 multi-turn coherence", async () => {
  const turn1 = await loggedRun("¿Cuántos tornillos hay en stock?", CTX);
  if (turn1.kind !== "final") return fail("1.kind", `expected final, got ${turn1.kind}`);
  createdConversationIds.push(turn1.conversationId);
  pass("1.first turn", `convId=${turn1.conversationId.slice(0, 8)}…`);

  const turn2 = await loggedRun("¿Y de aceite de oliva?", {
    ...CTX,
    conversationId: turn1.conversationId,
  });
  if (turn2.kind !== "final") return fail("1.kind2", `expected final, got ${turn2.kind}`);
  if (turn2.conversationId !== turn1.conversationId) {
    return fail("1.idStable", "conversationId changed across turns");
  }
  pass("1.second turn", "id stable across turns");

  const loaded = await loadConversationForAgent(supabase, turn1.conversationId);
  if (!loaded) return fail("1.load", "could not reload conversation");
  const userMsgs = loaded.messages.filter((m) => m.role === "user").length;
  if (userMsgs < 2) {
    return fail("1.persist", `expected >=2 user messages, got ${userMsgs}`);
  }
  pass("1.persisted", `${loaded.messages.length} messages total, ${userMsgs} user`);
});

// ---- 2. bounded context (unit) ------------------------------------------

await test("2 bounded context selectWindow", async () => {
  const records: { seq: number; item: AgentInputItem }[] = [];
  for (let i = 0; i < 80; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    records.push({
      seq: i + 1,
      item: {
        type: "message",
        role,
        content: [
          {
            type: role === "user" ? "input_text" : "output_text",
            text: `turn ${i}`,
          },
        ],
      } as AgentInputItem,
    });
  }
  const { window, droppedThroughSeq } = selectWindow(records);
  if (window.length > HISTORY_WINDOW_ITEMS + 2) {
    return fail("2.size", `window=${window.length} > cap=${HISTORY_WINDOW_ITEMS}+2`);
  }
  if (droppedThroughSeq === null) {
    return fail("2.dropped", "expected items to be dropped");
  }
  pass("2.window-size", `window=${window.length}, dropped through seq=${droppedThroughSeq}`);

  const callId = "call_test_pair";
  const pairRecords: { seq: number; item: AgentInputItem }[] = [];
  for (let i = 0; i < 60; i++) {
    pairRecords.push({
      seq: i + 1,
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `noise ${i}` }],
      } as AgentInputItem,
    });
  }
  pairRecords.push({
    seq: 61,
    item: {
      type: "function_call",
      callId,
      name: "resolveProduct",
      arguments: JSON.stringify({ query: "tornillo" }),
    } as unknown as AgentInputItem,
  });
  for (let i = 0; i < 50; i++) {
    pairRecords.push({
      seq: 62 + i,
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `after ${i}` }],
      } as AgentInputItem,
    });
  }
  pairRecords.push({
    seq: 200,
    item: {
      type: "function_call_result",
      callId,
      name: "resolveProduct",
      output: { type: "text", text: "[]" },
    } as unknown as AgentInputItem,
  });

  const paired = selectWindow(pairRecords);
  const hasCall = paired.window.some(
    (it) =>
      (it as unknown as { type?: string; callId?: string }).type === "function_call" &&
      (it as unknown as { callId?: string }).callId === callId,
  );
  const hasResult = paired.window.some(
    (it) =>
      (it as unknown as { type?: string; callId?: string }).type === "function_call_result" &&
      (it as unknown as { callId?: string }).callId === callId,
  );
  if (!hasCall || !hasResult) {
    return fail(
      "2.pairs",
      `pair-safety broken: hasCall=${hasCall}, hasResult=${hasResult}`,
    );
  }
  pass("2.pair-safety", "function_call + result both retained");
});

// ---- 3. tool resolution coherence ---------------------------------------

await test("3 tool resolution coherence", async () => {
  const conv = await createConversation(supabase, {
    organizationId: CTX.organizationId!,
    userId: CTX.userId,
    firstUserInput: "_seed_",
  });
  createdConversationIds.push(conv.id);

  const result = await loggedRun("¿Quién me surte tornillos?", {
    ...CTX,
    conversationId: conv.id,
  });
  if (result.kind !== "final") {
    return fail("3.kind", `expected final, got ${result.kind}`);
  }
  const loaded = await loadConversationForAgent(supabase, conv.id);
  if (!loaded) return fail("3.load", "could not reload");

  const toolCalls = loaded.messages
    .map((m) => m.payload as { type?: string; name?: string } | null)
    .filter((p) => p && p.type === "function_call");
  console.log(`  tool_calls: [${toolCalls.map((p) => p?.name).join(", ")}]`);

  const calledResolver = toolCalls.some((p) => p?.name === "resolveProduct");
  const calledLister = toolCalls.some((p) => p?.name === "listProductSuppliers");
  if (!calledResolver) {
    return fail("3.resolver", "expected resolveProduct in tool_calls");
  }
  if (!calledLister) {
    return fail("3.lister", "expected listProductSuppliers in tool_calls");
  }
  const idxResolve = loaded.messages.findIndex(
    (m) => (m.payload as { name?: string })?.name === "resolveProduct",
  );
  const idxList = loaded.messages.findIndex(
    (m) => (m.payload as { name?: string })?.name === "listProductSuppliers",
  );
  if (idxResolve > idxList) {
    return fail(
      "3.order",
      `resolveProduct (seq idx ${idxResolve}) after listProductSuppliers (${idxList})`,
    );
  }
  pass("3.chain", `resolveProduct@${idxResolve} → listProductSuppliers@${idxList}`);
});

// ---- 4. HITL restart -----------------------------------------------------

await test("4 HITL restart", async () => {
  const supplierName = `Proveedor Test ${Date.now()}`;
  const t1 = await loggedRun(
    `Da de alta al proveedor "${supplierName}", lead time 4 días.`,
    CTX,
  );
  createdConversationIds.push(t1.conversationId);
  if (t1.kind !== "awaiting_approval") {
    return fail("4.hitl", `expected awaiting_approval, got ${t1.kind}`);
  }

  const loadedMid = await loadConversationForAgent(supabase, t1.conversationId);
  if (!loadedMid?.conversation.pending_state) {
    return fail("4.pending", "pending_state not persisted");
  }
  if (loadedMid.conversation.status !== "awaiting_approval") {
    return fail("4.status", `status=${loadedMid.conversation.status}`);
  }
  pass(
    "4.pending-state-stored",
    `pending_approvals=${loadedMid.conversation.pending_approvals?.length}`,
  );

  const t2 = await loggedResume(
    null,
    t1.approvals.map((a) => ({ toolName: a.toolName, approved: true })),
    { ...CTX, conversationId: t1.conversationId },
  );
  if (t2.kind !== "final") {
    return fail("4.resume", `expected final after resume, got ${t2.kind}`);
  }
  const loadedAfter = await loadConversationForAgent(supabase, t1.conversationId);
  if (loadedAfter?.conversation.status !== "active") {
    return fail("4.cleared", `status after resume=${loadedAfter?.conversation.status}`);
  }
  if (loadedAfter?.conversation.pending_state !== null) {
    return fail("4.cleared-state", "pending_state not cleared");
  }
  pass("4.restart", "resumed from stored pending_state, status cleared");
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
