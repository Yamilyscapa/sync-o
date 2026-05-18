-- product_suppliers: M:N link between products and suppliers with per-link
-- economics. last_unit_cost_cents / last_purchased_at are trigger-maintained
-- snapshots from intake movements (see migration 3).

create table product_suppliers (
  product_id uuid not null references products(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete restrict,
  supplier_sku text,
  last_unit_cost_cents bigint check (last_unit_cost_cents >= 0),
  last_purchased_at timestamptz,
  lead_time_days int check (lead_time_days >= 0),
  min_order_qty numeric check (min_order_qty >= 0),
  is_preferred boolean not null default false,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, supplier_id)
);

create index product_suppliers_supplier_id_idx on product_suppliers (supplier_id);

-- At most one preferred-active supplier per product.
create unique index product_suppliers_one_preferred
  on product_suppliers (product_id)
  where is_preferred and is_active;

create trigger product_suppliers_updated_at
before update on product_suppliers
for each row execute function set_updated_at();

-- Cross-org integrity: product and supplier must share organization.
create or replace function product_suppliers_check_cross_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_org uuid;
  v_supplier_org uuid;
begin
  select organization_id into v_product_org
    from products where id = new.product_id;
  select organization_id into v_supplier_org
    from suppliers where id = new.supplier_id;

  if v_product_org is null then
    raise exception 'product_not_found: %', new.product_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_supplier_org is null then
    raise exception 'supplier_not_found: %', new.supplier_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_product_org <> v_supplier_org then
    raise exception 'cross_org: product org % vs supplier org %',
      v_product_org, v_supplier_org
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger product_suppliers_check_cross_org_trg
before insert or update on product_suppliers
for each row execute function product_suppliers_check_cross_org();

alter table product_suppliers enable row level security;

-- Members of the owning org can manage links (gate via product's org).
create policy product_suppliers_select on product_suppliers
for select to authenticated
using (is_org_member(product_org(product_id)));

create policy product_suppliers_insert on product_suppliers
for insert to authenticated
with check (is_org_member(product_org(product_id)));

create policy product_suppliers_update on product_suppliers
for update to authenticated
using (is_org_member(product_org(product_id)))
with check (is_org_member(product_org(product_id)));

create policy product_suppliers_delete on product_suppliers
for delete to authenticated
using (is_org_member(product_org(product_id)));
