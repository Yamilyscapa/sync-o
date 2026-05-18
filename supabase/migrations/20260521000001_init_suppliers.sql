-- Suppliers: per-org vendor catalog. Soft-delete via is_active; hard delete
-- blocked by FK restrict from stock_movements / product_suppliers once linked.

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  legal_name text,
  tax_id text,
  contact_name text,
  contact_email text,
  contact_phone text,
  default_lead_time_days int check (default_lead_time_days >= 0),
  payment_terms_days int check (payment_terms_days >= 0),
  currency text not null default 'MXN',
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index suppliers_org_name_unique
  on suppliers (organization_id, lower(name));
create index suppliers_organization_id_idx on suppliers (organization_id);

create trigger suppliers_updated_at
before update on suppliers
for each row execute function set_updated_at();

alter table suppliers enable row level security;

create policy suppliers_select on suppliers
for select to authenticated
using (is_org_member(organization_id));

create policy suppliers_insert on suppliers
for insert to authenticated
with check (is_org_role(organization_id, array['owner','admin']));

create policy suppliers_update on suppliers
for update to authenticated
using (is_org_role(organization_id, array['owner','admin']))
with check (is_org_role(organization_id, array['owner','admin']));

create policy suppliers_delete on suppliers
for delete to authenticated
using (is_org_role(organization_id, array['owner','admin']));
