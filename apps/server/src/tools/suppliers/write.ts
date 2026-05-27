import { tool } from "@openai/agents";
import { z } from "zod";
import type { AgentContext } from "../../agent.js";
import { SKU_REGEX_DESC } from "../../db/products/sku.js";
import type { SupplierWriteError } from "../../db/suppliers/schema.js";
import {
  createSupplier,
  deactivateSupplier,
  linkProductSupplier,
  setPreferredSupplier,
  unlinkProductSupplier,
  updateSupplier,
} from "../../db/suppliers/writes.js";
import { getSupabaseFromContext } from "../../supabase.js";
import { guardSku, guardUuid } from "../_guards.js";

const SKU_PARAM_DESC = `${SKU_REGEX_DESC}. MUST be a canonical SKU — if the user referenced the product by name, call resolveProduct FIRST.`;
const SUPPLIER_ID_DESC =
  "Supplier UUID. If the user gave a name, call resolveSupplier FIRST and use the returned candidates[0].id.";
const SUPPLIER_RESOLVER_HINT = `resolveSupplier({ query: "<name>" })`;

function translateSupplierError(e: SupplierWriteError): string {
  switch (e.kind) {
    case "duplicate_name":
      return `error: ya existe un proveedor llamado "${e.name}" en esta organización`;
    case "cross_org":
      return `error: el producto y el proveedor pertenecen a organizaciones distintas`;
    case "supplier_in_use":
      return `error: no se puede borrar este proveedor porque tiene movimientos o productos vinculados. Considera desactivarlo en lugar de borrarlo.`;
    case "not_found":
      return `error: no encontré el proveedor ${e.supplierId} en esta organización`;
    case "product_not_found":
      return `error: no encontré el producto con SKU ${e.sku} en esta organización`;
    case "link_exists":
      return `error: ese producto y proveedor ya están vinculados`;
    case "unknown":
      return `error: ${e.message}`;
    default: {
      const _exhaustive: never = e;
      return `error: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

export const createSupplierTool = tool({
  name: "createSupplier",
  needsApproval: true,
  description:
    "Register a new supplier in the caller's organization. Human-in-the-loop: the runtime interrupts so the user can approve. Only `name` is required; everything else optional. Do NOT ask the user for optional fields they did not mention. Do NOT fabricate any field.",
  parameters: z.object({
    name: z.string().min(1).describe("Supplier display name (required)"),
    legal_name: z
      .string()
      .nullable()
      .describe("Invoicing / legal name if different from display name"),
    tax_id: z.string().nullable().describe("Tax id (RFC in MX)"),
    contact_name: z.string().nullable().describe("Primary contact person"),
    contact_email: z.string().email().nullable().describe("Contact email"),
    contact_phone: z.string().nullable().describe("Contact phone"),
    default_lead_time_days: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Typical days between order and arrival"),
    payment_terms_days: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Net payment terms in days (e.g. 30 = net 30)"),
    currency: z
      .string()
      .nullable()
      .describe("ISO currency code; defaults to MXN if null"),
    notes: z.string().nullable().describe("Free-text notes in Spanish"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";
    try {
      const result = await createSupplier(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        {
          name: args.name,
          legal_name: args.legal_name,
          tax_id: args.tax_id,
          contact_name: args.contact_name,
          contact_email: args.contact_email,
          contact_phone: args.contact_phone,
          default_lead_time_days: args.default_lead_time_days,
          payment_terms_days: args.payment_terms_days,
          currency: args.currency ?? undefined,
          notes: args.notes,
        },
      );
      if (!result.ok) return translateSupplierError(result.error);
      return `proveedor creado: ${result.row.name} (id=${result.row.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const updateSupplierTool = tool({
  name: "updateSupplier",
  needsApproval: true,
  description:
    "Update fields on an existing supplier. Provide ONLY the fields the user asked to change; omit the rest. Human-in-the-loop.",
  parameters: z.object({
    supplierId: z.string().describe(SUPPLIER_ID_DESC),
    name: z.string().nullable().describe("New display name, or null to leave unchanged"),
    legal_name: z.string().nullable().describe("New legal name, or null to leave unchanged"),
    tax_id: z.string().nullable().describe("New tax id, or null to leave unchanged"),
    contact_name: z.string().nullable().describe("New contact name, or null to leave unchanged"),
    contact_email: z.string().email().nullable().describe("New email, or null to leave unchanged"),
    contact_phone: z.string().nullable().describe("New phone, or null to leave unchanged"),
    default_lead_time_days: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("New lead time in days, or null to leave unchanged"),
    payment_terms_days: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("New net payment days, or null to leave unchanged"),
    currency: z.string().nullable().describe("New currency code, or null to leave unchanged"),
    notes: z.string().nullable().describe("New notes, or null to leave unchanged"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const idErr = guardUuid(args.supplierId, "supplierId", SUPPLIER_RESOLVER_HINT);
    if (idErr) return idErr;

    const patch: Record<string, unknown> = {};
    if (args.name != null) patch.name = args.name;
    if (args.legal_name != null) patch.legal_name = args.legal_name;
    if (args.tax_id != null) patch.tax_id = args.tax_id;
    if (args.contact_name != null) patch.contact_name = args.contact_name;
    if (args.contact_email != null) patch.contact_email = args.contact_email;
    if (args.contact_phone != null) patch.contact_phone = args.contact_phone;
    if (args.default_lead_time_days != null)
      patch.default_lead_time_days = args.default_lead_time_days;
    if (args.payment_terms_days != null)
      patch.payment_terms_days = args.payment_terms_days;
    if (args.currency != null) patch.currency = args.currency;
    if (args.notes != null) patch.notes = args.notes;

    try {
      const result = await updateSupplier(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        args.supplierId,
        patch,
      );
      if (!result.ok) return translateSupplierError(result.error);
      return `proveedor actualizado: ${result.row.name} (id=${result.row.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const deactivateSupplierTool = tool({
  name: "deactivateSupplier",
  needsApproval: true,
  description:
    "Soft-delete a supplier by setting is_active=false. The supplier is hidden from default lists but historical movements and product links are preserved. Prefer this over hard deletion. Human-in-the-loop.",
  parameters: z.object({
    supplierId: z.string().describe(SUPPLIER_ID_DESC),
  }),
  execute: async ({ supplierId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const idErr = guardUuid(supplierId, "supplierId", SUPPLIER_RESOLVER_HINT);
    if (idErr) return idErr;

    try {
      const result = await deactivateSupplier(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        supplierId,
      );
      if (!result.ok) return translateSupplierError(result.error);
      return `proveedor desactivado: ${result.row.name} (id=${result.row.id})`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const linkProductSupplierTool = tool({
  name: "linkProductSupplier",
  needsApproval: true,
  description:
    "Create a link between a product (SKU) and a supplier (UUID), capturing per-link economics (supplier's own SKU code, lead time override, min order qty, preferred flag). Human-in-the-loop. Resolve supplier by name via `resolveSupplier` BEFORE calling this; never invent UUIDs.",
  parameters: z.object({
    sku: z.string().describe(SKU_PARAM_DESC),
    supplierId: z.string().describe(SUPPLIER_ID_DESC),
    supplierSku: z
      .string()
      .nullable()
      .describe("The supplier's own SKU code for this product"),
    leadTimeDays: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Override of supplier's default lead time, in days"),
    minOrderQty: z
      .number()
      .nonnegative()
      .nullable()
      .describe("Minimum order quantity from this supplier"),
    isPreferred: z
      .boolean()
      .describe(
        "If true, mark this link as the preferred supplier for this product (unsets any prior preferred).",
      ),
    notes: z.string().nullable().describe("Free-text notes in Spanish"),
  }),
  execute: async (args, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(args.sku);
    if (skuErr) return skuErr;
    const idErr = guardUuid(args.supplierId, "supplierId", SUPPLIER_RESOLVER_HINT);
    if (idErr) return idErr;

    try {
      const result = await linkProductSupplier(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        {
          sku: args.sku,
          supplierId: args.supplierId,
          supplierSku: args.supplierSku,
          leadTimeDays: args.leadTimeDays,
          minOrderQty: args.minOrderQty,
          isPreferred: args.isPreferred,
          notes: args.notes,
        },
      );
      if (!result.ok) return translateSupplierError(result.error);
      return `vínculo creado: ${args.sku} <-> proveedor ${args.supplierId}${args.isPreferred ? " (preferido)" : ""}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const unlinkProductSupplierTool = tool({
  name: "unlinkProductSupplier",
  needsApproval: true,
  description:
    "Remove the link between a product and a supplier. The supplier and product remain; only the link row is deleted. Historical movements that referenced this supplier are unaffected. Human-in-the-loop.",
  parameters: z.object({
    sku: z.string().describe(SKU_PARAM_DESC),
    supplierId: z.string().describe(SUPPLIER_ID_DESC),
  }),
  execute: async ({ sku, supplierId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(sku);
    if (skuErr) return skuErr;
    const idErr = guardUuid(supplierId, "supplierId", SUPPLIER_RESOLVER_HINT);
    if (idErr) return idErr;

    try {
      const result = await unlinkProductSupplier(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        sku,
        supplierId,
      );
      if (!result.ok) return translateSupplierError(result.error);
      return `vínculo eliminado: ${sku} <-> proveedor ${supplierId}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});

export const setPreferredSupplierTool = tool({
  name: "setPreferredSupplier",
  needsApproval: true,
  description:
    "Mark a supplier as the preferred supplier for a product. Any prior preferred supplier for the same product is automatically unmarked. The link must already exist (create it first with `linkProductSupplier`). Human-in-the-loop.",
  parameters: z.object({
    sku: z.string().describe(SKU_PARAM_DESC),
    supplierId: z.string().describe(SUPPLIER_ID_DESC),
  }),
  execute: async ({ sku, supplierId }, runContext) => {
    const ctx = runContext?.context as AgentContext | undefined;
    if (!ctx) return "error: missing run context";
    if (!ctx.organizationId) return "error: missing organizationId in context";

    const skuErr = guardSku(sku);
    if (skuErr) return skuErr;
    const idErr = guardUuid(supplierId, "supplierId", SUPPLIER_RESOLVER_HINT);
    if (idErr) return idErr;

    try {
      const result = await setPreferredSupplier(
        getSupabaseFromContext(ctx),
        ctx.organizationId,
        sku,
        supplierId,
      );
      if (!result.ok) return translateSupplierError(result.error);
      return `proveedor preferido actualizado: ${sku} -> ${supplierId}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
});
