-- Wide read model: one row per product with stock + attributes as jsonb.
-- Filter via attributes->>'color' = '...', attributes->>'brand' = '...', etc.
-- RLS is inherited from the underlying tables (security_invoker = on).

create view products_searchable
with (security_invoker = on)
as
select
  p.id,
  p.organization_id,
  p.sku,
  p.name,
  p.description,
  p.unit,
  p.price_cents,
  p.currency,
  p.is_active,
  p.created_at,
  p.updated_at,
  coalesce(s.quantity, 0) as quantity,
  coalesce(a.attributes, '{}'::jsonb) as attributes
from products p
left join product_stock s on s.product_id = p.id
left join lateral (
  select jsonb_object_agg(
    d.key,
    coalesce(
      to_jsonb(pa.value_text),
      to_jsonb(pa.value_number),
      to_jsonb(pa.value_bool),
      to_jsonb(pa.value_date)
    )
  ) as attributes
  from product_attributes pa
  join attribute_definitions d on d.id = pa.definition_id
  where pa.product_id = p.id
) a on true;

comment on view products_searchable is
  'Per-product wide view. attributes jsonb keyed by attribute_definitions.key. Filter with attributes->>''key''.';
