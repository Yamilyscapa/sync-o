-- Products, attributes (EAV → definitions), centralized stock.

create table products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  sku text not null,
  name text not null,
  description text,
  unit text,
  price_cents bigint,
  currency text not null default 'MXN',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sku)
);

create index products_organization_id_idx on products (organization_id);

create trigger products_updated_at
before update on products
for each row execute function set_updated_at();

create table product_stock (
  product_id uuid primary key references products(id) on delete cascade,
  quantity numeric not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now()
);

create trigger product_stock_updated_at
before update on product_stock
for each row execute function set_updated_at();

-- Auto-create stock row alongside product.
create or replace function products_init_stock()
returns trigger
language plpgsql
as $$
begin
  insert into product_stock (product_id, quantity) values (new.id, 0);
  return new;
end;
$$;

create trigger products_init_stock_trg
after insert on products
for each row execute function products_init_stock();

create table product_attributes (
  product_id uuid not null references products(id) on delete cascade,
  definition_id uuid not null references attribute_definitions(id) on delete restrict,
  value_text text,
  value_number numeric,
  value_bool boolean,
  value_date date,
  primary key (product_id, definition_id),
  constraint product_attributes_one_value check (
    (case when value_text   is not null then 1 else 0 end)
  + (case when value_number is not null then 1 else 0 end)
  + (case when value_bool   is not null then 1 else 0 end)
  + (case when value_date   is not null then 1 else 0 end)
  = 1
  )
);

create index product_attributes_definition_id_idx on product_attributes (definition_id);

-- Enforce: populated value_* slot matches the definition's value_type.
create or replace function product_attributes_check_type()
returns trigger
language plpgsql
as $$
declare
  vt text;
begin
  select value_type into vt from attribute_definitions where id = new.definition_id;
  if vt is null then
    raise exception 'attribute definition % not found', new.definition_id;
  end if;
  if vt = 'text'   and new.value_text   is null then raise exception 'value_text required for text attribute'; end if;
  if vt = 'number' and new.value_number is null then raise exception 'value_number required for number attribute'; end if;
  if vt = 'bool'   and new.value_bool   is null then raise exception 'value_bool required for bool attribute'; end if;
  if vt = 'date'   and new.value_date   is null then raise exception 'value_date required for date attribute'; end if;
  return new;
end;
$$;

create trigger product_attributes_check_type_trg
before insert or update on product_attributes
for each row execute function product_attributes_check_type();

-- Helper: org owner of a product.
create or replace function product_org(p_product_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from products where id = p_product_id;
$$;

-- RLS.
alter table products enable row level security;
alter table product_stock enable row level security;
alter table product_attributes enable row level security;

-- products: full CRUD by org members.
create policy products_select on products
for select to authenticated
using (is_org_member(organization_id));

create policy products_insert on products
for insert to authenticated
with check (is_org_member(organization_id));

create policy products_update on products
for update to authenticated
using (is_org_member(organization_id))
with check (is_org_member(organization_id));

create policy products_delete on products
for delete to authenticated
using (is_org_member(organization_id));

-- product_stock: select only. No client writes — triggers create rows;
-- the future stock_movements table will be the sole writer.
create policy product_stock_select on product_stock
for select to authenticated
using (is_org_member(product_org(product_id)));

-- product_attributes: CRUD by org members.
create policy product_attributes_select on product_attributes
for select to authenticated
using (is_org_member(product_org(product_id)));

create policy product_attributes_insert on product_attributes
for insert to authenticated
with check (is_org_member(product_org(product_id)));

create policy product_attributes_update on product_attributes
for update to authenticated
using (is_org_member(product_org(product_id)))
with check (is_org_member(product_org(product_id)));

create policy product_attributes_delete on product_attributes
for delete to authenticated
using (is_org_member(product_org(product_id)));
