-- Standardized attribute vocabulary. Global rows (organization_id is null)
-- are shared across tenants; per-org rows let orgs add custom keys.

create table attribute_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  key text not null,
  label text not null,
  value_type text not null check (value_type in ('text','number','bool','date')),
  unit text,
  is_searchable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One global definition per key, plus one per-org override per key.
create unique index attribute_definitions_org_key_idx
on attribute_definitions (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

create trigger attribute_definitions_updated_at
before update on attribute_definitions
for each row execute function set_updated_at();

-- Seed canonical global vocabulary.
insert into attribute_definitions (organization_id, key, label, value_type, unit) values
  (null, 'color',             'Color',              'text',   null),
  (null, 'size',               'Size',               'text',   null),
  (null, 'material',           'Material',           'text',   null),
  (null, 'brand',              'Brand',              'text',   null),
  (null, 'weight_kg',          'Weight',             'number', 'kg'),
  (null, 'length_cm',          'Length',             'number', 'cm'),
  (null, 'width_cm',           'Width',              'number', 'cm'),
  (null, 'height_cm',          'Height',             'number', 'cm'),
  (null, 'volume_ml',          'Volume',             'number', 'ml'),
  (null, 'voltage_v',          'Voltage',            'number', 'V'),
  (null, 'wattage_w',          'Wattage',            'number', 'W'),
  (null, 'expires_at',         'Expires at',         'date',   null),
  (null, 'batch_code',         'Batch code',         'text',   null),
  (null, 'barcode',            'Barcode',            'text',   null),
  (null, 'country_of_origin',  'Country of origin',  'text',   null);

alter table attribute_definitions enable row level security;

-- Select: global rows visible to all authenticated users; per-org rows to members.
create policy attribute_definitions_select on attribute_definitions
for select to authenticated
using (organization_id is null or is_org_member(organization_id));

-- Mutations only on per-org rows by owner/admin. Global rows immutable from client.
create policy attribute_definitions_insert on attribute_definitions
for insert to authenticated
with check (organization_id is not null and is_org_role(organization_id, array['owner','admin']));

create policy attribute_definitions_update on attribute_definitions
for update to authenticated
using (organization_id is not null and is_org_role(organization_id, array['owner','admin']))
with check (organization_id is not null and is_org_role(organization_id, array['owner','admin']));

create policy attribute_definitions_delete on attribute_definitions
for delete to authenticated
using (organization_id is not null and is_org_role(organization_id, array['owner','admin']));
