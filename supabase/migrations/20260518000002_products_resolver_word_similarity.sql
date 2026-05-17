-- Switch resolver from similarity() to word_similarity() for substring/word matching
-- (e.g. "tornillos" → "Tornillo M8x40 ..." scores 0.8 vs 0.29 with similarity()).

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
    greatest(
      word_similarity(p_query, v.name),
      word_similarity(p_query, v.sku) * 0.85
    ) as score
  from products_searchable v
  where v.organization_id = p_org
    and (p_query <% v.name or p_query <% v.sku)
  order by score desc
  limit greatest(1, least(p_limit, 20));
$$;
