-- Reversal-flow guarantees on stock_movements:
--   - At most one reversal per original movement (partial unique index).
--   - Trigger blocks reversals that point at missing / cross-org / already-
--     reversal rows, and enforces delta = -original.delta server-side.

create unique index if not exists stock_movements_reversal_unique
  on stock_movements (related_movement_id)
  where reason = 'reversal';

create or replace function stock_movements_apply_delta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_org   uuid;
  v_qty           numeric;
  v_new_qty       numeric;
  v_orig_reason   text;
  v_orig_delta    numeric;
  v_orig_product  uuid;
  v_orig_org      uuid;
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

  if new.reason = 'reversal' then
    if new.related_movement_id is null then
      raise exception 'reversal_target_missing: related_movement_id is null'
        using errcode = 'check_violation';
    end if;

    select reason, delta, product_id, organization_id
      into v_orig_reason, v_orig_delta, v_orig_product, v_orig_org
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
