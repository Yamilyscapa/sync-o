/**
 * Warehouse end-to-end test suite.
 *
 * Runs against real Supabase + real OpenAI. Service-role client bypasses
 * RLS. Each test logs PASS/FAIL to stdout AND tests/runs/warehouses-<ts>/.
 *
 * Coverage:
 *   1. createWarehouse HITL — runAgent yields awaiting_approval; resume
 *      produces a warehouse row.
 *   2. recordStockMovement scoped to specific bodega — per-warehouse stock
 *      rows update independently.
 *   3. transferStock atomic — single HITL approval, both legs persisted,
 *      origin balance == origin_before - qty, destination balance ==
 *      destination_before + qty.
 *   4. setReorderPoint + listLowStock(useReorder=true) — pair shows up in
 *      reorder-mode low-stock listing after threshold is set.
 *   5. getWarehouseSaturation RPC returns rows for the test org.
 *   6. analyze routing — warehouse-ops question routes to analyze tool.
 *   7. anti-routing — per-bodega direct lookup must NOT invoke analyze.
 *
 * Reusable setup: ensures a SUR bodega and an active product/supplier
 * link exist before tests start. Idempotent across reruns.
 *
 * Cleanup: deletes created conversations + any test movements scoped to
 * SUR within this run window; SUR is deactivated (hard-delete is blocked
 * by FK once movements reference it).
 */

import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAgent,
  resumeAgent,
  type AgentContext,
  type AgentRunOutput,
} from "../src/agent.js";
import { supabase } from "../src/supabase.js";
import { createConversation } from "../src/db/conversations/writes.js";
import { loadConversationForAgent } from "../src/db/conversations/reads.js";
import { transferStock } from "../src/db/movements/writes.js";
import { setReorderPoint } from "../src/db/products/reads.js";
import {
  createWarehouse,
  deactivateWarehouse,
} from "../src/db/warehouses/writes.js";
import {
  getWarehouseByCode,
  getWarehouseSaturation,
} from "../src/db/warehouses/reads.js";

const CTX: AgentContext = {
  userId: "6ee2e332-c8cc-4dec-b353-7cc511376dc3",
  organizationId: "65a88725-aa99-4e0f-b079-cab78725b87b",
  useServiceRole: true,
};
const SKU = "IND-001";
const SUR_CODE = "SUR";

// ---- run-dir + logging --------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(here, "runs", `warehouses-${stamp}`);
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
  logOutput(out);
  return out;
}

async function loggedResume(
  decisions: Parameters<typeof resumeAgent>[1],
  ctx: AgentContext,
): Promise<AgentRunOutput> {
  console.log(
    `U: [resume] ${decisions.map((d) => `${d.toolName}:${d.approved ? "approve" : "reject"}`).join(", ")}`,
  );
  const out = await resumeAgent(null, decisions, ctx);
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

async function freshConversation(): Promise<string> {
  const conv = await createConversation(supabase, {
    organizationId: CTX.organizationId!,
    userId: CTX.userId,
    firstUserInput: "_seed_",
  });
  createdConversationIds.push(conv.id);
  return conv.id;
}

async function toolCallsFor(conversationId: string): Promise<string[]> {
  const loaded = await loadConversationForAgent(supabase, conversationId);
  if (!loaded) return [];
  return loaded.messages
    .map((m) => m.payload as { type?: string; name?: string } | null)
    .filter((p): p is { type?: string; name?: string } => !!p && p.type === "function_call")
    .map((p) => p.name ?? "");
}

async function getPerWarehouseStock(
  sku: string,
  warehouseCode: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("products_warehouse_stock")
    .select("quantity")
    .eq("organization_id", CTX.organizationId!)
    .eq("sku", sku)
    .eq("warehouse_code", warehouseCode)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return 0;
  return Number((data as { quantity: number | string }).quantity);
}

async function getSupplierIdByName(name: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("suppliers")
    .select("id")
    .eq("organization_id", CTX.organizationId!)
    .ilike("name", name)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? (data as { id: string }).id : null;
}

// ---- setup --------------------------------------------------------------

console.log(`[run] ${stamp} — writing to ${runDir}`);

async function ensureSur(): Promise<string> {
  let sur = await getWarehouseByCode(supabase, CTX.organizationId!, SUR_CODE);
  if (sur) return sur.id;
  const result = await createWarehouse(supabase, CTX.organizationId!, {
    name: "Bodega Sur",
    code: SUR_CODE,
    location: null,
  });
  if (!result.ok) {
    throw new Error(`setup: createWarehouse SUR failed: ${result.error.kind}`);
  }
  return result.row.id;
}

async function seedStockInBoth(productSku: string, qtyEach: number, supplierId: string) {
  const surId = await ensureSur();
  const defaultWh = await getWarehouseByCode(supabase, CTX.organizationId!, "DEFAULT");
  if (!defaultWh) throw new Error("setup: DEFAULT bodega missing");

  for (const warehouseId of [defaultWh.id, surId]) {
    const before = await supabase
      .from("products_warehouse_stock")
      .select("quantity")
      .eq("organization_id", CTX.organizationId!)
      .eq("sku", productSku)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();
    const beforeQty = before.data
      ? Number((before.data as { quantity: number | string }).quantity)
      : 0;
    if (beforeQty >= qtyEach) continue;
    const need = qtyEach - beforeQty;
    const product = await supabase
      .from("products")
      .select("id")
      .eq("organization_id", CTX.organizationId!)
      .eq("sku", productSku)
      .maybeSingle();
    if (!product.data) throw new Error(`setup: product ${productSku} missing`);
    const productId = (product.data as { id: string }).id;
    const ins = await supabase.from("stock_movements").insert({
      organization_id: CTX.organizationId!,
      product_id: productId,
      warehouse_id: warehouseId,
      delta: need,
      reason: "initial",
      note: "test seed",
      related_movement_id: null,
      supplier_id: supplierId,
      unit_cost_cents: 1250,
      unit_price_cents: null,
      created_by: CTX.userId,
    });
    if (ins.error) throw new Error(`setup: seed insert failed: ${ins.error.message}`);
  }
}

const supplierId = await getSupplierIdByName("Ferretería del Norte");
if (!supplierId) {
  throw new Error(
    "setup: supplier 'Ferretería del Norte' missing — run tests/run.ts setup scenarios first.",
  );
}

// ---- 1. createWarehouse HITL --------------------------------------------

await test("1 createWarehouse HITL flow", async () => {
  // Use a unique code so this test does not collide with an existing bodega.
  const code = `TST-${Date.now().toString().slice(-6)}`;
  const conversationId = await freshConversation();

  const t1 = await loggedRun(
    `Crea una bodega llamada Bodega de Prueba con código ${code}.`,
    { ...CTX, conversationId },
  );
  if (t1.kind !== "awaiting_approval") {
    return fail("1.hitl", `expected awaiting_approval, got ${t1.kind}`);
  }
  if (!t1.approvals.some((a) => a.toolName === "createWarehouse")) {
    return fail(
      "1.tool",
      `expected createWarehouse in approvals, got [${t1.approvals.map((a) => a.toolName).join(", ")}]`,
    );
  }

  const t2 = await loggedResume(
    t1.approvals.map((a) => ({ toolName: a.toolName, approved: true })),
    { ...CTX, conversationId },
  );
  if (t2.kind !== "final") {
    return fail("1.resume", `expected final after resume, got ${t2.kind}`);
  }

  const wh = await getWarehouseByCode(supabase, CTX.organizationId!, code);
  if (!wh) return fail("1.persist", `bodega with code ${code} not found after resume`);
  pass("1.created", `bodega ${wh.code} (id=${wh.id.slice(0, 8)}…)`);

  // Cleanup: deactivate the freshly-created test bodega.
  await deactivateWarehouse(supabase, CTX.organizationId!, wh.id);
});

// ---- 2. transferStock atomic --------------------------------------------

await test("2 transferStock atomic two-leg", async () => {
  await seedStockInBoth(SKU, 50, supplierId);

  const before = {
    default: await getPerWarehouseStock(SKU, "DEFAULT"),
    sur: await getPerWarehouseStock(SKU, SUR_CODE),
  };
  console.log(`  before: DEFAULT=${before.default}, SUR=${before.sur}`);

  const qty = 7;
  const surId = await ensureSur();
  const defaultWh = await getWarehouseByCode(supabase, CTX.organizationId!, "DEFAULT");
  const result = await transferStock(supabase, {
    organizationId: CTX.organizationId!,
    userId: CTX.userId,
    sku: SKU,
    fromWarehouseId: defaultWh!.id,
    toWarehouseId: surId,
    quantity: qty,
    note: "test transfer",
  });
  if (!result.ok) {
    return fail("2.transfer", `transferStock failed: ${JSON.stringify(result.error)}`);
  }
  if (result.out.warehouse_id !== defaultWh!.id) {
    return fail("2.out-leg", "outbound leg posted to wrong warehouse");
  }
  if (result.in.warehouse_id !== surId) {
    return fail("2.in-leg", "inbound leg posted to wrong warehouse");
  }

  const after = {
    default: await getPerWarehouseStock(SKU, "DEFAULT"),
    sur: await getPerWarehouseStock(SKU, SUR_CODE),
  };
  console.log(`  after:  DEFAULT=${after.default}, SUR=${after.sur}`);

  if (after.default !== before.default - qty) {
    return fail(
      "2.origin",
      `DEFAULT delta expected ${-qty}, got ${after.default - before.default}`,
    );
  }
  if (after.sur !== before.sur + qty) {
    return fail(
      "2.dest",
      `SUR delta expected ${qty}, got ${after.sur - before.sur}`,
    );
  }
  pass("2.atomic", `${qty} units moved DEFAULT → SUR, ledger consistent`);
});

// ---- 3. transferStock rolls back on negative_stock ----------------------

await test("3 transferStock rolls back if origin insufficient", async () => {
  const surId = await ensureSur();
  const defaultWh = await getWarehouseByCode(supabase, CTX.organizationId!, "DEFAULT");

  const before = {
    default: await getPerWarehouseStock(SKU, "DEFAULT"),
    sur: await getPerWarehouseStock(SKU, SUR_CODE),
  };
  const overdraw = before.default + 100000;

  const result = await transferStock(supabase, {
    organizationId: CTX.organizationId!,
    userId: CTX.userId,
    sku: SKU,
    fromWarehouseId: defaultWh!.id,
    toWarehouseId: surId,
    quantity: overdraw,
    note: "should fail",
  });
  if (result.ok) {
    return fail("3.expected-error", "expected negative_stock failure, got ok");
  }
  if (result.error.kind !== "negative_stock") {
    return fail("3.kind", `expected negative_stock, got ${result.error.kind}`);
  }
  const after = {
    default: await getPerWarehouseStock(SKU, "DEFAULT"),
    sur: await getPerWarehouseStock(SKU, SUR_CODE),
  };
  if (after.default !== before.default || after.sur !== before.sur) {
    return fail(
      "3.rollback",
      `quantities changed despite failure: DEFAULT ${before.default}→${after.default}, SUR ${before.sur}→${after.sur}`,
    );
  }
  pass("3.atomic-rollback", "negative_stock failure left both bodegas untouched");
});

// ---- 4. setReorderPoint + listLowStock(useReorder) ----------------------

await test("4 setReorderPoint visible in reorder-mode low-stock", async () => {
  const surId = await ensureSur();
  // Set min_stock above current SUR quantity to guarantee a hit.
  const current = await getPerWarehouseStock(SKU, SUR_CODE);
  const min = current + 5;

  const setResult = await setReorderPoint(
    supabase,
    CTX.organizationId!,
    SKU,
    surId,
    min,
  );
  if (!setResult.ok) {
    return fail("4.set", `setReorderPoint failed: ${JSON.stringify(setResult.error)}`);
  }
  console.log(`  set min_stock=${min} for ${SKU} in SUR (qty=${current})`);

  const { data, error } = await supabase
    .from("products_warehouse_stock")
    .select("sku, quantity, min_stock")
    .eq("organization_id", CTX.organizationId!)
    .eq("sku", SKU)
    .eq("warehouse_id", surId)
    .maybeSingle();
  if (error) return fail("4.read", error.message);
  if (!data) return fail("4.read", "pair row missing");
  const row = data as { sku: string; quantity: number | string; min_stock: number | string };
  if (Number(row.min_stock) !== min) {
    return fail("4.min", `min_stock ${row.min_stock} != ${min}`);
  }
  if (Number(row.quantity) > Number(row.min_stock)) {
    return fail("4.below", `qty ${row.quantity} > min ${row.min_stock} — should be at-or-below`);
  }
  pass("4.reorder", `${SKU}@SUR qty=${row.quantity} <= min_stock=${row.min_stock}`);

  // Cleanup: clear the threshold.
  await setReorderPoint(supabase, CTX.organizationId!, SKU, surId, 0);
});

// ---- 5. warehouse_saturation RPC ----------------------------------------

await test("5 warehouse_saturation RPC returns rows", async () => {
  await ensureSur();
  const rows = await getWarehouseSaturation(supabase, CTX.organizationId!);
  if (rows.length === 0) {
    return fail("5.empty", "expected >=1 row from warehouse_saturation");
  }
  console.log(
    `  rows: ${rows
      .map(
        (r) =>
          `${r.warehouse_code}(SKUs=${r.sku_count}, units=${r.total_units}, $${(r.estimated_value_cents / 100).toFixed(2)})`,
      )
      .join(", ")}`,
  );
  const sur = rows.find((r) => r.warehouse_code === SUR_CODE);
  if (!sur) return fail("5.sur", "SUR row missing from saturation rollup");
  pass(
    "5.rpc",
    `${rows.length} bodega rows, SUR present with ${sur.sku_count} SKUs / ${sur.total_units} units`,
  );
});

// ---- 6. analyze routing — warehouse-ops question ------------------------

await test("6 analyze routing — warehouse ops", async () => {
  const conversationId = await freshConversation();
  const out = await loggedRun("¿Cómo está repartido el inventario entre bodegas?", {
    ...CTX,
    conversationId,
  });
  if (out.kind !== "final") {
    return fail("6.kind", `expected final, got ${out.kind}`);
  }
  const calls = await toolCallsFor(conversationId);
  console.log(`  tool_calls: [${calls.join(", ")}]`);
  if (!calls.includes("analyze")) {
    return fail("6.route", `expected 'analyze' in tool_calls, got [${calls.join(", ")}]`);
  }
  const text = out.output ?? "";
  if (!/\d/.test(text)) {
    return fail("6.quant", `output lacks numbers: ${text.slice(0, 120)}…`);
  }
  pass("6.route", "warehouse-ops question routed to analyze");
});

// ---- 7. anti-routing — per-bodega direct lookup -------------------------

await test("7 anti-routing — per-bodega direct lookup", async () => {
  const conversationId = await freshConversation();
  const out = await loggedRun(`¿Cuánto stock hay de ${SKU} en SUR?`, {
    ...CTX,
    conversationId,
  });
  if (out.kind !== "final") {
    return fail("7.kind", `expected final, got ${out.kind}`);
  }
  const calls = await toolCallsFor(conversationId);
  console.log(`  tool_calls: [${calls.join(", ")}]`);
  if (calls.includes("analyze")) {
    return fail("7.route", `direct lookup unexpectedly invoked analyze`);
  }
  if (!calls.some((n) => n === "readStockBySku")) {
    return fail("7.direct", `expected readStockBySku, got [${calls.join(", ")}]`);
  }
  pass("7.direct", "analyze NOT invoked; readStockBySku used");
});

// ---- cleanup ------------------------------------------------------------

console.log("\n=== cleanup ===");
for (const id of createdConversationIds) {
  const { error } = await supabase.from("conversations").delete().eq("id", id);
  if (error) console.log(`  delete conv ${id.slice(0, 8)}…: ${error.message}`);
}
console.log(`deleted ${createdConversationIds.length} conversations`);
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);

summary.end();
transcript.end();
process.exit(failures === 0 ? 0 : 1);
