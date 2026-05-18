-- Most-recent sale price per (org, product). Used by recordMovement to default
-- unit_price_cents for sales when the caller doesn't supply one. RLS inherited
-- from the base table.

create or replace view product_last_sale_price as
select distinct on (organization_id, product_id)
  organization_id,
  product_id,
  unit_price_cents,
  created_at as last_sold_at
from stock_movements
where reason = 'sale' and unit_price_cents is not null
order by organization_id, product_id, created_at desc;
