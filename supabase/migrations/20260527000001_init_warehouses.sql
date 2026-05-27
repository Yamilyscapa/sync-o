-- Warehouses: per-org physical/logical stock locations. Soft-delete via
-- is_active; hard delete blocked by FK restrict from stock_movements /
-- product_stock once any quantity or movement references the warehouse.

create table warehouses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  code text not null,
  location text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint warehouses_code_format check (code ~ '^[A-Z0-9-]{2,16}$')
);

create unique index warehouses_org_name_unique
  on warehouses (organization_id, lower(name));
create unique index warehouses_org_code_unique
  on warehouses (organization_id, upper(code));
create index warehouses_organization_id_idx on warehouses (organization_id);

create trigger warehouses_updated_at
before update on warehouses
for each row execute function set_updated_at();

-- Helper: org owner of a warehouse.
create or replace function warehouse_org(p_warehouse_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id from warehouses where id = p_warehouse_id;
$$;

alter table warehouses enable row level security;

create policy warehouses_select on warehouses
for select to authenticated
using (is_org_member(organization_id));

create policy warehouses_insert on warehouses
for insert to authenticated
with check (is_org_role(organization_id, array['owner','admin']));

create policy warehouses_update on warehouses
for update to authenticated
using (is_org_role(organization_id, array['owner','admin']))
with check (is_org_role(organization_id, array['owner','admin']));

create policy warehouses_delete on warehouses
for delete to authenticated
using (is_org_role(organization_id, array['owner','admin']));
