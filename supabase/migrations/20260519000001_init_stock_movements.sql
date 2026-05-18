-- Append-only ledger of stock changes. Trigger updates product_stock.quantity.
-- product_stock is no longer client-writable; movements are the sole writer.

create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  delta numeric not null check (delta <> 0),
  reason text not null check (reason in (
    'intake','sale','adjustment','loss','transfer','reversal','initial'
  )),
  note text,
  related_movement_id uuid references stock_movements(id) on delete set null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_org_created_idx
  on stock_movements (organization_id, created_at desc);
create index if not exists stock_movements_product_created_idx
  on stock_movements (product_id, created_at desc);
create index if not exists stock_movements_org_reason_created_idx
  on stock_movements (organization_id, reason, created_at desc);

create or replace function stock_movements_apply_delta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_org uuid;
  v_qty         numeric;
  v_new_qty     numeric;
begin
  select organization_id into v_product_org
    from products where id = new.product_id;

  if v_product_org is null then
    raise exception 'product_not_found: %', new.product_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_product_org <> new.organization_id then
    raise exception 'cross_org: product % belongs to org %, movement org %',
      new.product_id, v_product_org, new.organization_id
      using errcode = 'check_violation';
  end if;

  select quantity into v_qty
    from product_stock
    where product_id = new.product_id
    for update;

  if v_qty is null then
    insert into product_stock (product_id, quantity)
      values (new.product_id, 0)
      on conflict (product_id) do nothing;
    v_qty := 0;
  end if;

  v_new_qty := v_qty + new.delta;
  if v_new_qty < 0 then
    raise exception 'negative_stock: product % would go to %', new.product_id, v_new_qty
      using errcode = 'check_violation';
  end if;

  update product_stock
    set quantity = v_new_qty, updated_at = now()
    where product_id = new.product_id;

  return new;
end;
$$;

drop trigger if exists stock_movements_apply_delta_trg on stock_movements;
create trigger stock_movements_apply_delta_trg
  before insert on stock_movements
  for each row
  execute function stock_movements_apply_delta();

alter table stock_movements enable row level security;

drop policy if exists stock_movements_select on stock_movements;
create policy stock_movements_select on stock_movements
  for select
  using (is_org_member(organization_id));

drop policy if exists stock_movements_insert on stock_movements;
create policy stock_movements_insert on stock_movements
  for insert
  with check (
    is_org_member(organization_id)
    and created_by = (select auth.uid())
  );

-- No update / delete policies: append-only.
