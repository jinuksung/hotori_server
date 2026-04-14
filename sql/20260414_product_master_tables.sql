create table if not exists public.product_master (
  id bigserial primary key,
  category_id bigint references public.categories(id) on delete set null,
  normalized_brand text,
  normalized_product_name text not null,
  normalized_spec text,
  product_group_key text not null unique,
  canonical_title text,
  canonical_source text,
  canonical_product_url text,
  confidence numeric(5,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_product_master_category_id
  on public.product_master(category_id);

create index if not exists idx_product_master_group_key
  on public.product_master(product_group_key);

create table if not exists public.deal_product_mapping (
  deal_id bigint primary key references public.deals(id) on delete cascade,
  product_master_id bigint not null references public.product_master(id) on delete cascade,
  match_method text not null,
  match_confidence numeric(5,4),
  matched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_deal_product_mapping_product_master_id
  on public.deal_product_mapping(product_master_id);
