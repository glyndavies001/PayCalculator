-- Vaulted 1.18.5: a regular bill remembers its earlier amounts, so changing it applies from a
-- month on and earlier months keep what they were. history: [{"to":"YYYY-MM","total":n}, ...]
-- sorted by "to" = the amount up to and including that month; "total" applies after the last.
alter table public.shared_bills add column if not exists history jsonb;
alter table public.glyn_bills add column if not exists history jsonb;
notify pgrst, 'reload schema';
