import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { AgentContext } from "../src/agent.js";
import { runConversation, type ApprovalAction } from "./harness.js";
import { allScenarios, type Scenario } from "./scenarios.js";

// ! Debug harness: bypasses RLS via service-role client. Remove before production.
const ctx: AgentContext = {
  userId: "6ee2e332-c8cc-4dec-b353-7cc511376dc3",
  organizationId: "65a88725-aa99-4e0f-b079-cab78725b87b",
  useServiceRole: true,
};

const here = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(here, "runs", stamp);
mkdirSync(runDir, { recursive: true });

const summary = createWriteStream(join(runDir, "summary.log"));
const transcript = createWriteStream(join(runDir, "transcript.log"));
const origLog = console.log;
let currentScenarioStream: ReturnType<typeof createWriteStream> | null = null;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  origLog(line);
  summary.write(line + "\n");
  if (currentScenarioStream) currentScenarioStream.write(line + "\n");
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

function normalize(s: Scenario): { turns: string[]; approvals: ApprovalAction[] } {
  if (typeof s === "string") return { turns: [s], approvals: [] };
  if (Array.isArray(s)) return { turns: s, approvals: [] };
  return { turns: s.turns, approvals: s.approvals ?? [] };
}

console.log(`[run] ${stamp} — writing to ${runDir}`);

for (let i = 0; i < allScenarios.length; i++) {
  const { turns, approvals } = normalize(allScenarios[i]!);
  const idx = String(i + 1).padStart(2, "0");
  const file = join(runDir, `${idx}-${slug(turns[0]!)}.log`);
  currentScenarioStream = createWriteStream(file);
  try {
    await runConversation(turns, ctx, approvals);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(`A: [scenario failed: ${err.status ?? "err"} — ${err.message ?? e}]`);
    console.log();
  } finally {
    currentScenarioStream.end();
    currentScenarioStream = null;
  }
}

summary.end();
transcript.end();
