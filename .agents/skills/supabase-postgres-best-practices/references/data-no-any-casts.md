---
title: Never Cast DB Results to `any` — Parse Through Zod Instead
impact: HIGH
impactDescription: Eliminates silent schema drift and runtime crashes from PostgREST type coercion (numerics-as-strings, jsonb-as-unknown)
tags: typescript, typing, zod, db-types, safety
---

## Rule: No `any` Casts on Database Results

Treat every row coming back from Supabase / PostgREST as **unknown** until validated. Use a Zod schema next to each typed return value and parse before exposing the data to the rest of the app. The only acceptable `any` is on **type generic parameters** that are intentionally unconstrained (e.g. `SupabaseClient<any, any>` when the generated DB types are not yet available, or library generics that the caller cannot specialize). Casts of *runtime values* (`x as Foo`, `x as any`, `<Foo>x`) are forbidden unless paired with an immediately preceding validation step.

**Why it matters:**

- PostgREST returns `numeric` and `bigint` columns as **strings**. A `.select<{ qty: number }>()` cast lies — `typeof row.qty === "string"` at runtime, breaking arithmetic silently.
- `jsonb` columns arrive as `unknown` (or worse, typed as a hand-written interface that drifts from the column schema).
- `maybeSingle()` returns `T | null`, but the `T` is whatever the caller asserted — Supabase's client types are **not authoritative** against the live schema.
- A bad cast surfaces as `NaN`, `undefined.foo`, or a corrupted write months later. A Zod parse fails at the boundary with a clear error pointing at the offending field.

**Incorrect (silent drift, runtime hazards):**

```ts
// Cast lies about the runtime type — PostgREST returns numeric as string.
type ProductStockRow = { sku: string; quantity: number };

const { data } = await supabase
  .from("products_searchable")
  .select("sku, quantity")
  .eq("sku", sku)
  .maybeSingle();

return data as ProductStockRow | null;
// data.quantity is actually "500" at runtime; later `qty * 2` becomes "5002".
```

**Correct (parse at the boundary, derive the type from the schema):**

```ts
import { z } from "zod";

export const ProductStockRowSchema = z.object({
  sku: z.string(),
  quantity: z.coerce.number(), // PostgREST returns numeric/bigint as string
});
export type ProductStockRow = z.infer<typeof ProductStockRowSchema>;

const { data, error } = await supabase
  .from("products_searchable")
  .select("sku, quantity")
  .eq("sku", sku)
  .maybeSingle();

if (error) throw new Error(error.message);
if (!data) return null;
return ProductStockRowSchema.parse(data); // throws on drift, type is derived
```

**Allowed uses of `any` (generics only, with justification):**

- `SupabaseClient<any, any>` in helper signatures when generated DB types are not yet wired up.
- Library generic slots the caller cannot specialize (e.g. `z.infer<typeof Schema as any>` when chaining schemas inside a generic helper).
- Function generic parameters such as `<T extends Record<string, any>>` where the constraint must intentionally accept arbitrary shape.

Each allowed `any` should carry a one-line comment naming the reason (`// generic: caller not known`, `// pg client untyped`, etc.). If the reason can be removed (e.g. by generating DB types), open a TODO and remove the `any` once unblocked.

**Trade-offs:**

- One Zod parse per row is O(field count); negligible vs. the network/DB cost.
- Schemas must be kept in sync with the migration; rotate them in the same PR that changes the column.
- `z.coerce.number()` will accept stringified non-numbers like `"NaN"`. If that matters, use `z.coerce.number().finite()`.

Reference: [PostgREST resource representation](https://postgrest.org/en/stable/api.html#resource-representation), [Zod docs](https://zod.dev/), project rule codified in `CLAUDE.md` ("Zod is mandatory at every I/O boundary").
