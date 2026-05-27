-- Trigram-based fuzzy resolver for natural-language → canonical SKU.

create extension if not exists pg_trgm;

create index products_name_trgm_idx on products using gin (name gin_trgm_ops);
create index products_sku_trgm_idx  on products using gin (sku  gin_trgm_ops);

create or replace function search_products_by_text(
  p_org   uuid,
  p_query text,
  p_limit int default 5
)
returns table (
  sku        text,
  name       text,
  quantity   numeric,
  attributes jsonb,
  score      real
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    v.sku,
    v.name,
    v.quantity,
    v.attributes,
    greatest(similarity(v.name, p_query), similarity(v.sku, p_query) * 0.85) as score
  from products_searchable v
  where v.organization_id = p_org
    and (v.name % p_query or v.sku % p_query)
  order by score desc
  limit greatest(1, least(p_limit, 20));
$$;
