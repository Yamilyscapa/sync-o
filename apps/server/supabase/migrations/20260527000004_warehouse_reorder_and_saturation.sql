-- Per (product, warehouse) reorder threshold + saturation RPC for sub-agent F8.
-- min_stock defaults to 0 so existing rows are unaffected. listLowStock can
-- choose between an org-wide explicit threshold and the per-pair min_stock.

alter table product_stock
  add column min_stock numeric not null default 0
  check (min_stock >= 0);

-- Refresh per-warehouse view to surface min_stock.
drop view if exists products_warehouse_stock;
create view products_warehouse_stock
with (security_invoker = on)
as
select
  p.id as product_id,
  p.organization_id,
  p.sku,
  p.name,
  p.is_active as product_is_active,
  w.id as warehouse_id,
  w.code as warehouse_code,
  w.name as warehouse_name,
  w.is_active as warehouse_is_active,
  coalesce(ps.quantity, 0) as quantity,
  coalesce(ps.min_stock, 0) as min_stock,
  ps.updated_at as stock_updated_at
from products p
join warehouses w on w.organization_id = p.organization_id
left join product_stock ps
  on ps.product_id = p.id and ps.warehouse_id = w.id;

comment on view products_warehouse_stock is
  'Cross-product of products X warehouses within each org. quantity and min_stock default to 0 when no stock row exists.';

-- Aggregate per-bodega snapshot for F8 (warehouse saturation).
-- Returns one row per warehouse in the caller's org: SKU count with stock,
-- total units, valuation in cents using the preferred-supplier last cost.
create or replace function warehouse_saturation(p_org uuid)
returns table(
  warehouse_id uuid,
  warehouse_code text,
  warehouse_name text,
  is_active boolean,
  sku_count int,
  total_units numeric,
  estimated_value_cents bigint
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    w.id as warehouse_id,
    w.code as warehouse_code,
    w.name as warehouse_name,
    w.is_active,
    count(*) filter (where ps.quantity > 0)::int as sku_count,
    coalesce(sum(ps.quantity), 0) as total_units,
    coalesce(
      sum(ps.quantity * coalesce(pref.last_unit_cost_cents, 0))::bigint,
      0
    ) as estimated_value_cents
  from warehouses w
  left join product_stock ps on ps.warehouse_id = w.id
  left join lateral (
    select last_unit_cost_cents
    from product_suppliers
    where product_id = ps.product_id
      and is_preferred = true
      and is_active = true
    limit 1
  ) pref on true
  where w.organization_id = p_org
  group by w.id, w.code, w.name, w.is_active;
$$;

comment on function warehouse_saturation(uuid) is
  'Per-warehouse aggregate: SKU count with stock, total units, estimated value (Σ qty × preferred-supplier last cost).';
