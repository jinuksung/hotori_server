#!/bin/sh
set -eu
CSV_PATH="$1"
DB_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed 's/^"//; s/"$//')
psql "$DB_URL" -v ON_ERROR_STOP=1 <<SQL
create temporary table tmp_shopping_keyword_rank (
  id bigint,
  collected_at date,
  category_name text,
  category_cid text,
  keyword text,
  rank integer,
  period_start date,
  period_end date,
  created_at timestamptz
);
\copy tmp_shopping_keyword_rank from '$CSV_PATH' with (format csv, header true)
insert into public.shopping_keyword_rank (id, collected_at, category_name, category_cid, keyword, rank, period_start, period_end, created_at)
select id, collected_at, category_name, category_cid, keyword, rank, period_start, period_end, created_at
from tmp_shopping_keyword_rank
on conflict (collected_at, category_cid, keyword) do update
set rank = excluded.rank,
    period_start = excluded.period_start,
    period_end = excluded.period_end;
select setval(pg_get_serial_sequence('public.shopping_keyword_rank','id'), (select max(id) from public.shopping_keyword_rank));
SQL
