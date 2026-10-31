-- Paydays set by hand, by month ({"2026-12": "2026-12-22"}): work paying early for Christmas, say.
-- Both phones read them; Glyn's sets them from the "Paid in" line at the top of Vaulted.
alter table public.shared_settings add column if not exists paydays jsonb not null default '{}'::jsonb;
