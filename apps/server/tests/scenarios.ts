// Single-turn = string. Multi-turn = string[] (subsequent strings are user replies
// threaded as conversation history, used to exercise clarification flows).
//
// Scenario order matters: the first few prompts SEED state (create supplier,
// link to SKU, first intake with cost) so later scenarios can exercise the
// "recurring intake/sale defaults from snapshot" path. Each scenario is its
// own conversation (fresh agent), but DB state persists across them.

import type { ApprovalAction } from "./harness.js";

export type RichScenario = {
  turns: string[];
  approvals?: ApprovalAction[];
};

export type Scenario = string | string[] | RichScenario;

export const setupScenarios: Scenario[] = [
  // Idempotent: create-supplier may fail on duplicate_name on repeat runs;
  // the agent surfaces the duplicate error and the rest of the suite still runs.
  "Da de alta al proveedor Ferretería del Norte, lead time 5 días.",
  "Vincula Ferretería del Norte con IND-001.",
  "Ingresaron 100 tornillos de Ferretería del Norte a 12.50 cada uno.",
];

export const readSanityScenarios: Scenario[] = [
  "What is the stock of IND-001?",
];

export const clarificationScenarios: Scenario[] = [
  // Intake without explicit supplier: agent must ASK.
  ["Ingresaron 50 tornillos al almacén.", "De Ferretería del Norte."],
  // Sale into a SKU that exists but has zero stock — must surface negative_stock.
  "Vendí 3 taladros.",
  // Ambiguous outflow verbs.
  ["Saca 10 tornillos.", "Dale, registralo."],
  ["Quita 5 tornillos del inventario.", "Es por merma."],
];

export const readToolScenarios: Scenario[] = [
  "Muestra el historial de IND-001.",
  "Ajusta el stock de aceite de oliva: el conteo físico dio 55.",
  "¿Qué movimientos hubo recientemente?",
];

export const reversalScenarios: Scenario[] = [
  // Reversal flow: register intake, then undo it. Supplier named inline.
  [
    "Ingresaron 200 tornillos al almacén de Ferretería del Norte.",
    "Espera, fue un error. Deshaz ese último ingreso.",
  ],
  // "borra" must redirect to reversal (append-only ledger).
  [
    "Ingresaron 7 tornillos de Ferretería del Norte.",
    "Borra ese último ingreso, fue equivocado.",
  ],
  // Distinguish reversal from correction: legit sale + follow-up sale, not a reversal.
  ["Vendí 2 tornillos.", "Ah no, fueron 4 los que vendí, registra los 2 que faltan."],
  // Idempotency: double reversal must fail with "ya fue reversado".
  ["Vendí 1 tornillo.", "Reversa ese movimiento.", "Reversa otra vez ese movimiento."],
];

export const pricingDefaultScenarios: Scenario[] = [
  // Recurring intake — agent should not ask for cost in chat; HITL preview shows defaulted value.
  "Ingresaron 50 tornillos más de Ferretería del Norte.",
  // Recurring sale — agent should not ask for price in chat.
  "Vendí 3 tornillos.",
  // Explicit price override (pesos → cents: 110 pesos = 11000 cents).
  "Véndelo a 110 pesos cada uno, fueron 2 tornillos.",
];

export const supplierReadScenarios: Scenario[] = [
  "¿Quién me surte tornillos?",
  "Marca a Ferretería del Norte como preferido para IND-001.",
];

// Rejection regressions: harness rejects the first approval with a corrective
// message; agent must re-call the write tool with the corrected param without
// chat-asking. Exercises src/prompts/system.ts rule: "On HITL rejection with a
// corrective amount … re-call the tool with the corrected value."
export const rejectionRegressionScenarios: Scenario[] = [
  {
    turns: ["Ingresaron 10 tornillos de Ferretería del Norte a 12.50 cada uno."],
    approvals: [
      {
        match: "recordStockMovement",
        approve: false,
        message: "El costo real fue $14.00, no $12.50.",
      },
      { match: "recordStockMovement", approve: true },
    ],
  },
  // Fallback 2-turn variant: if the model chat-asks instead of auto-re-calling,
  // a follow-up "registralo a 14" still exercises the corrected-approval entry
  // in the policy queue and confirms the harness mechanism end-to-end.
  {
    turns: [
      "Ingresaron 8 tornillos de Ferretería del Norte a 12.50 cada uno.",
      "Registralo a $14.00.",
    ],
    approvals: [
      {
        match: "recordStockMovement",
        approve: false,
        message: "El costo real fue $14.00, no $12.50.",
      },
      { match: "recordStockMovement", approve: true },
    ],
  },
];

export const resolutionRegressionScenarios: Scenario[] = [
  // Same flow that previously looped on "parámetros inválidos": should now
  // either resolve supplier in one chain, or recover from supplierId_not_resolved.
  "Ingresaron 80 tornillos de Ferretería del Norte.",
  // SKU + supplier both by name in same turn — must chain resolveProduct + resolveSupplier.
  "Marca a 'Ferretería del Norte' como preferido para tornillos.",
];

// Warehouse scenarios — multi-bodega flow, transfers, reorder, bulk init,
// warehouse-aware analyses. Designed to be idempotent across reruns: the
// "create bodega" turn surfaces a duplicate_name error on repeat runs and
// the rest still runs.
export const warehouseScenarios: Scenario[] = [
  // Create a second bodega so subsequent scenarios can disambiguate.
  "Crea una bodega llamada Bodega Sur con código SUR.",
  // List bodegas — read-only catalog browse.
  "Lista las bodegas.",
  // Intake to a specific bodega: agent must call resolveWarehouse first.
  "Ingresaron 30 tornillos de Ferretería del Norte a la bodega SUR a 12.50 cada uno.",
  // Per-bodega stock lookup.
  "¿Cuánto stock hay de IND-001 en SUR?",
  // Aggregate + breakdown when SKU spans >1 bodega.
  "¿Cómo está repartido IND-001 entre bodegas?",
  // Atomic transfer — single HITL covers both legs.
  ["Traslada 5 tornillos de la bodega principal a SUR.", "Dale."],
  // Reorder point per (product, bodega).
  "Establece el punto de reorden de IND-001 en SUR a 20.",
  // Warehouse-ops analyses → must route to analyze.
  "¿Qué le falta a SUR?",
  "¿Qué se vende más en SUR?",
  "¿Qué bodega está más cargada?",
  // Cross-bodega availability question.
  "Necesito 50 tornillos, ¿de qué bodega los saco?",
];

// Analysis sub-agent scenarios. The main agent must route these to the
// `analyze` tool; the sub-agent returns a Spanish prose summary with numbers.
// Negative cases (direct lookups) must NOT route to `analyze`.
export const analysisScenarios: Scenario[] = [
  // Replenishment — should hit analyze, mention SKU + suggested qty + supplier.
  "¿Qué productos debo reponer?",
  // Sales trend — top movers / velocity over default window.
  "¿Cómo van las ventas de los últimos 30 días?",
  // Margin — depends on price_cents vs last unit_cost_cents per product.
  "¿Cómo está el margen de los tornillos?",
  // Supplier performance — cost variance + observed lead time approx.
  "¿Cómo va el desempeño de Ferretería del Norte?",
  // Negative — direct lookup, must NOT call analyze.
  "¿Cuánto stock hay de IND-001?",
];

export const allScenarios: Scenario[] = [
  ...setupScenarios,
  ...readSanityScenarios,
  ...clarificationScenarios,
  ...readToolScenarios,
  ...reversalScenarios,
  ...pricingDefaultScenarios,
  ...supplierReadScenarios,
  ...resolutionRegressionScenarios,
  ...rejectionRegressionScenarios,
  ...warehouseScenarios,
  ...analysisScenarios,
];
