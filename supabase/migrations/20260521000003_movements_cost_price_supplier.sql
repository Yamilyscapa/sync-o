-- Extend stock_movements with supplier, unit cost (intake/initial), unit price
-- (sale). Reversal trigger inherits supplier/cost/price from original. Intake/
-- initial inserts snapshot last_unit_cost_cents into product_suppliers.
--
-- Pre-existing rows: any old intake/initial rows have null unit_cost_cents.
-- The new CHECKs apply only to new rows; historical rows are preserved as-is.

alter table stock_movements
  add column supplier_id uuid references suppliers(id) on delete restrict,
  add column unit_cost_cents bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  add column unit_price_cents bigint check (unit_price_cents is null or unit_price_cents >= 0);

alter table stock_movements
  add column total_cost_cents bigint
    generated always as (unit_cost_cents * abs(delta)) stored,
  add column total_revenue_cents bigint
    generated always as (unit_price_cents * abs(delta)) stored;

-- Cost required for intake/initial; price required for sale. Marked NOT VALID
-- so pre-existing rows (created before these columns existed) are not
-- retroactively rejected; new inserts still enforce the constraint.
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

-- supplier_id only allowed on intake / initial / reversal.
alter table stock_movements
  add constraint stock_movements_supplier_reason_scope check (
    supplier_id is null
    or reason in ('intake','initial','reversal')
  );

create index stock_movements_supplier_id_idx
  on stock_movements (supplier_id)
  where supplier_id is not null;

-- Extend trigger:
--   * cross-org assert on supplier_id
--   * reversal inherits supplier_id, unit_cost_cents, unit_price_cents from original
--   * on intake/initial insert, upsert product_suppliers snapshot
create or replace function stock_movements_apply_delta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_org    uuid;
  v_qty            numeric;
  v_new_qty        numeric;
  v_orig_reason    text;
  v_orig_delta     numeric;
  v_orig_product   uuid;
  v_orig_org       uuid;
  v_orig_supplier  uuid;
  v_orig_cost      bigint;
  v_orig_price     bigint;
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
           supplier_id, unit_cost_cents, unit_price_cents
      into v_orig_reason, v_orig_delta, v_orig_product, v_orig_org,
           v_orig_supplier, v_orig_cost, v_orig_price
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

    -- Inherit supplier / cost / price from original. Caller passes nulls.
    new.supplier_id := v_orig_supplier;
    new.unit_cost_cents := v_orig_cost;
    new.unit_price_cents := v_orig_price;
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

-- After-insert: snapshot product_suppliers from intake/initial movements.
create or replace function stock_movements_snapshot_supplier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reason in ('intake','initial')
     and new.supplier_id is not null
     and new.unit_cost_cents is not null then
    insert into product_suppliers (
      product_id, supplier_id, last_unit_cost_cents, last_purchased_at
    ) values (
      new.product_id, new.supplier_id, new.unit_cost_cents, new.created_at
    )
    on conflict (product_id, supplier_id) do update
      set last_unit_cost_cents = excluded.last_unit_cost_cents,
          last_purchased_at = excluded.last_purchased_at,
          updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists stock_movements_snapshot_supplier_trg on stock_movements;
create trigger stock_movements_snapshot_supplier_trg
after insert on stock_movements
for each row execute function stock_movements_snapshot_supplier();
