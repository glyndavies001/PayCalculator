-- Vaulted ⇄ Monzo, update 2 (v1.15.0): bills ticked off against their payments.
-- (Applied as bank_prefs.)

-- Which payment pays each bill, the pots counted as house savings, and the amounts Vaulted filled
-- in for bills that vary. Only its owner can read or change it, and only from a two-step session.
-- It goes when the Monzo link goes (unlinking deletes the bank_links row).
create table if not exists public.bank_prefs (
  user_id uuid primary key references public.bank_links (user_id) on delete cascade,
  links jsonb not null default '{}'::jsonb,        -- "s:<bill id>" / "g:<bill id>" -> {k: payee key | "od" | "none", n: name}
  house_pots jsonb not null default '[]'::jsonb,   -- pot ids
  fills jsonb not null default '{}'::jsonb,        -- bill -> {"YYYY-MM": amount Vaulted filled in}
  updated_at timestamptz not null default now()
);
alter table public.bank_prefs enable row level security;
revoke all on public.bank_prefs from anon, authenticated;
grant select, insert, update, delete on public.bank_prefs to authenticated;
grant all on public.bank_prefs to service_role;
drop policy if exists "own bank prefs after two-step" on public.bank_prefs;
create policy "own bank prefs after two-step" on public.bank_prefs for all to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2')
  with check (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- What Glyn's phone shares with Hollie: how the shared bills stand this month, and the house
-- pots' total. Nothing else from the bank goes here.
alter table public.shared_settings add column if not exists bank_summary jsonb;

notify pgrst, 'reload schema';

-- ── After review (applied as bank_summary_guard) ──────────────────────────────────────────
-- Only someone with a live Monzo link can share a summary, and only under their own name; a write
-- that isn't allowed leaves the saved one as it was. Taking it back (null) is always allowed, and
-- unlinking (deleting the bank_links row) takes back that person's summary.
create or replace function public.bank_summary_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.bank_summary is null then return new; end if;
  if tg_op = 'UPDATE' then
    if new.bank_summary is not distinct from old.bank_summary then return new; end if;
  elsif exists (select 1 from public.shared_settings s where s.id = new.id) then
    return new;   -- an upsert over an existing row: checked as the update
  end if;
  if auth.uid() is null
     or (new.bank_summary ->> 'by') is distinct from auth.uid()::text
     or not exists (select 1 from public.bank_links l where l.user_id = auth.uid() and l.refresh_token is not null) then
    if tg_op = 'UPDATE' then new.bank_summary := old.bank_summary; else new.bank_summary := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists bank_summary_guard on public.shared_settings;
create trigger bank_summary_guard before insert or update on public.shared_settings
  for each row execute function public.bank_summary_guard();

create or replace function public.bank_links_forget_summary() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.shared_settings set bank_summary = null where bank_summary ->> 'by' = old.user_id::text;
  return old;
end $$;
drop trigger if exists bank_links_forget_summary on public.bank_links;
create trigger bank_links_forget_summary after delete on public.bank_links
  for each row execute function public.bank_links_forget_summary();
revoke all on function public.bank_summary_guard() from public, anon, authenticated;
revoke all on function public.bank_links_forget_summary() from public, anon, authenticated;
