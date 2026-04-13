create table if not exists public.coupang_goldbox_history (
  fetched_date date not null,
  product_id text not null,
  product_name text not null,
  product_price numeric null,
  product_url text not null,
  image_url text null,
  category_name text null,
  mapped_category_id bigint null references public.categories(id),
  mapping_confidence numeric null,
  is_rocket boolean not null default false,
  is_free_shipping boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (fetched_date, product_id)
);

create table if not exists public.coupang_goldbox_current (
  product_id text primary key,
  product_name text not null,
  product_price numeric null,
  product_url text not null,
  image_url text null,
  category_name text null,
  mapped_category_id bigint null references public.categories(id),
  mapping_confidence numeric null,
  is_rocket boolean not null default false,
  is_free_shipping boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_collected_at timestamptz not null default now(),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_coupang_goldbox_current_last_seen_at
  on public.coupang_goldbox_current (last_seen_at desc);
