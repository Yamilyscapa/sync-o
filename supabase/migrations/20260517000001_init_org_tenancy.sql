-- Organizations + membership + RLS helpers.

create extension if not exists "pgcrypto";

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_user_id_idx on organization_members (user_id);

-- Shared updated_at trigger fn (used by later migrations too).
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Membership helper. Stable + plpgsql so RLS planner can cache.
create or replace function is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org
      and user_id = (select auth.uid())
  );
$$;

create or replace function is_org_role(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from organization_members
    where organization_id = org
      and user_id = (select auth.uid())
      and role = any(roles)
  );
$$;

-- Auto-add creator as owner.
create or replace function organizations_add_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is not null then
    insert into organization_members (organization_id, user_id, role)
    values (new.id, (select auth.uid()), 'owner');
  end if;
  return new;
end;
$$;

create trigger organizations_add_owner_trg
after insert on organizations
for each row execute function organizations_add_owner();

-- RLS.
alter table organizations enable row level security;
alter table organization_members enable row level security;

create policy organizations_select on organizations
for select to authenticated
using (is_org_member(id));

create policy organizations_insert on organizations
for insert to authenticated
with check (true);

create policy organizations_update on organizations
for update to authenticated
using (is_org_role(id, array['owner']))
with check (is_org_role(id, array['owner']));

create policy organizations_delete on organizations
for delete to authenticated
using (is_org_role(id, array['owner']));

create policy organization_members_select on organization_members
for select to authenticated
using (is_org_member(organization_id));

create policy organization_members_insert on organization_members
for insert to authenticated
with check (is_org_role(organization_id, array['owner','admin']));

create policy organization_members_update on organization_members
for update to authenticated
using (is_org_role(organization_id, array['owner','admin']))
with check (is_org_role(organization_id, array['owner','admin']));

create policy organization_members_delete on organization_members
for delete to authenticated
using (is_org_role(organization_id, array['owner','admin']));
