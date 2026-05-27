-- Refactor product_stock from singleton-per-product to composite
-- (product_id, warehouse_id). One DEFAULT warehouse per org receives existing
-- rows so totals stay identical post-migration.

-- 1. Seed a DEFAULT warehouse for every org that owns at least one product.
insert into warehouses (organization_id, name, code)
select distinct p.organization_id, 'Bodega principal', 'DEFAULT'
from products p
on conflict do nothing;

-- 2. Drop the auto-stock-row trigger (lazy creation by movements trigger now).
drop trigger if exists products_init_stock_trg on products;
drop function if exists products_init_stock();

-- 3. Refactor product_stock to composite key.
alter table product_stock drop constraint product_stock_pkey;
alter table product_stock add column warehouse_id uuid;

update product_stock ps
set warehouse_id = w.id
from warehouses w
join products p on p.organization_id = w.organization_id
where p.id = ps.product_id and w.code = 'DEFAULT';

alter table product_stock alter column warehouse_id set not null;
alter table product_stock
  add constraint product_stock_warehouse_fk
    foreign key (warehouse_id) references warehouses(id) on delete restrict;
alter table product_stock
  add constraint product_stock_pkey primary key (product_id, warehouse_id);

create index product_stock_warehouse_idx on product_stock (warehouse_id);

-- 4. Refresh products_searchable: aggregate stock across warehouses so the
-- legacy `quantity` column means "total across all bodegas".
drop view if exists products_searchable;
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
  coalesce(s.total_quantity, 0) as quantity,
  coalesce(a.attributes, '{}'::jsonb) as attributes
from products p
left join lateral (
  select sum(quantity) as total_quantity
  from product_stock
  where product_id = p.id
) s on true
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
  'Per-product wide view. quantity is sum across all warehouses. attributes jsonb keyed by attribute_definitions.key.';

-- 5. Per-warehouse projection used by warehouse-scoped stock reads.
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
  ps.updated_at as stock_updated_at
from products p
join warehouses w on w.organization_id = p.organization_id
left join product_stock ps
  on ps.product_id = p.id and ps.warehouse_id = w.id;

comment on view products_warehouse_stock is
  'Cross-product of products X warehouses within each org. quantity is 0 when no stock row exists for the pair.';
