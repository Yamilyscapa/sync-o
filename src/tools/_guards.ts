// Resolution-discipline guards. Convert silent SDK schema rejections into
// actionable tool-result strings that tell the agent exactly which resolver
// helper to call next. The model recovers from these messages reliably; it
// does not always recover from opaque Zod errors.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_RE = /^[A-Z]{2,5}-\d{3,}$/;

/**
 * Returns an actionable error string if `value` is a non-empty non-UUID,
 * otherwise null. Pass through nulls untouched.
 */
export function guardUuid(
  value: string | null | undefined,
  fieldName: string,
  resolverHint: string,
): string | null {
  if (value == null || value === "") return null;
  if (UUID_RE.test(value)) return null;
  return (
    `error: ${fieldName}_not_resolved — "${value}" is not a UUID. ` +
    `Call ${resolverHint} FIRST to obtain a canonical UUID, then retry this tool ` +
    `with that id. Do NOT retry with the same value.`
  );
}

/**
 * Returns an actionable error string if `value` is not a canonical SKU,
 * otherwise null.
 */
export function guardSku(
  value: string,
  resolverHint = `resolveProduct({ query: "<text>" })`,
): string | null {
  if (SKU_RE.test(value)) return null;
  return (
    `error: sku_not_resolved — "${value}" is not a canonical SKU ` +
    `(expected ^[A-Z]{2,5}-\\d{3,}$). Call ${resolverHint} FIRST and use the ` +
    `returned candidate's sku, then retry this tool. Do NOT retry with the same value.`
  );
}
