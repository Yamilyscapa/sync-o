-- Add warehouse_id to stock_movements. Backfill historical rows to each org's
-- DEFAULT warehouse, then enforce NOT NULL. Rewrite apply_delta to:
--   * cross-org assert on warehouse_id
--   * inherit warehouse_id on reversal
--   * upsert product_stock keyed on (product_id, warehouse_id)

-- Drop NOT VALID cost/price checks before backfill: even NOT VALID checks
-- re-fire on row UPDATE, which would reject historical rows that lack
-- unit_cost_cents / unit_price_cents. Recreated NOT VALID after backfill.
alter table stock_movements drop constraint stock_movements_cost_required;
alter table stock_movements drop constraint stock_movements_price_required;

alter table stock_movements
  add column warehouse_id uuid references warehouses(id) on delete restrict;

update stock_movements sm
set warehouse_id = w.id
from warehouses w
where w.organization_id = sm.organization_id and w.code = 'DEFAULT';

alter table stock_movements alter column warehouse_id set not null;

alter table stock_movements
  add constraint stock_movements_cost_required check (
    case when reason in ('intake','initial')
      then unit_cost_cents is not null
      else true
    end
  ) not valid;

alter table stock_movements
  add constraint stock_movements_price_required check (
    case when reason = 'sale'
      then unit_price_cents is not null
      else true
    end
  ) not valid;

create index stock_movements_warehouse_created_idx
  on stock_movements (warehouse_id, created_at desc);

create or replace function stock_movements_apply_delta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_org    uuid;
  v_warehouse_org  uuid;
  v_qty            numeric;
  v_new_qty        numeric;
  v_orig_reason    text;
  v_orig_delta     numeric;
  v_orig_product   uuid;
  v_orig_org       uuid;
  v_orig_supplier  uuid;
  v_orig_cost      bigint;
  v_orig_price     bigint;
  v_orig_warehouse uuid;
  v_supplier_org   uuid;
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

  select organization_id into v_warehouse_org
    from warehouses where id = new.warehouse_id;

  if v_warehouse_org is null then
    raise exception 'warehouse_not_found: %', new.warehouse_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_warehouse_org <> new.organization_id then
    raise exception 'cross_org: warehouse % belongs to org %, movement org %',
      new.warehouse_id, v_warehouse_org, new.organization_id
      using errcode = 'check_violation';
  end if;

  if new.supplier_id is not null then
    select organization_id into v_supplier_org
      from suppliers where id = new.supplier_id;
    if v_supplier_org is null then
      raise exception 'supplier_not_found: %', new.supplier_id
        using errcode = 'foreign_key_violation';
    end if;
    if v_supplier_org <> new.organization_id then
      raise exception 'cross_org: supplier % belongs to org %, movement org %',
        new.supplier_id, v_supplier_org, new.organization_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.reason = 'reversal' then
    if new.related_movement_id is null then
      raise exception 'reversal_target_missing: related_movement_id is null'
        using errcode = 'check_violation';
    end if;

    select reason, delta, product_id, organization_id,
           supplier_id, unit_cost_cents, unit_price_cents, warehouse_id
      into v_orig_reason, v_orig_delta, v_orig_product, v_orig_org,
           v_orig_supplier, v_orig_cost, v_orig_price, v_orig_warehouse
      from stock_movements
      where id = new.related_movement_id;

    if v_orig_reason is null then
      raise exception 'reversal_target_missing: %', new.related_movement_id
        using errcode = 'check_violation';
    end if;

    if v_orig_org <> new.organization_id then
      raise exception 'cross_org: reversal target % belongs to org %, movement org %',
        new.related_movement_id, v_orig_org, new.organization_id
        using errcode = 'check_violation';
    end if;

    if v_orig_product <> new.product_id then
      raise exception 'reversal_product_mismatch: target product %, movement product %',
        v_orig_product, new.product_id
        using errcode = 'check_violation';
    end if;

    if v_orig_reason = 'reversal' then
      raise exception 'reversal_of_reversal: % is already a reversal',
        new.related_movement_id
        using errcode = 'check_violation';
    end if;

    if new.delta <> -v_orig_delta then
      raise exception 'reversal_delta_mismatch: expected % got %',
        -v_orig_delta, new.delta
        using errcode = 'check_violation';
    end if;

    -- Inherit warehouse / supplier / cost / price from original. Caller passes nulls.
    new.warehouse_id := v_orig_warehouse;
    new.supplier_id := v_orig_supplier;
    new.unit_cost_cents := v_orig_cost;
    new.unit_price_cents := v_orig_price;
  end if;

  select quantity into v_qty
    from product_stock
    where product_id = new.product_id and warehouse_id = new.warehouse_id
    for update;

  if v_qty is null then
    insert into product_stock (product_id, warehouse_id, quantity)
      values (new.product_id, new.warehouse_id, 0)
      on conflict (product_id, warehouse_id) do nothing;
    v_qty := 0;
  end if;

  v_new_qty := v_qty + new.delta;
  if v_new_qty < 0 then
    raise exception 'negative_stock: product % in warehouse % would go to %',
      new.product_id, new.warehouse_id, v_new_qty
      using errcode = 'check_violation';
  end if;

  update product_stock
    set quantity = v_new_qty, updated_at = now()
    where product_id = new.product_id and warehouse_id = new.warehouse_id;

  return new;
end;
$$;
