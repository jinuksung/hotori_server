alter table public.deals
  add column if not exists deal_group_key text null;

create index if not exists idx_deals_deal_group_key
  on public.deals (deal_group_key);
