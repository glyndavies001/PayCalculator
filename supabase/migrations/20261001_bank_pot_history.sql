-- Vaulted ⇄ Monzo (v1.15.2): money paid by card straight from a pot.
-- (Applied as bank_pot_history.)
--
-- Monzo lists money moving between a pot and its account, but not a card payment taken straight
-- from a pot (Netflix from the Bills pot, say). So each time a pot's balance is saved it's noted
-- here: a new row when it has changed, otherwise that row's last_seen moves on. The app compares
-- the balances with the moves Monzo does list, and what's left is what was paid from the pot, and
-- between which two checks. Rows older than 200 days are dropped as new ones come in.

create table if not exists public.bank_pot_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.bank_links (user_id) on delete cascade,
  pot_id text not null,
  balance bigint not null,
  first_seen timestamptz not null,
  last_seen timestamptz not null
);
create index if not exists bank_pot_history_pot_idx on public.bank_pot_history (user_id, pot_id, first_seen desc);

-- Like the other bank data: read-only, own rows, two-step sessions only.
alter table public.bank_pot_history enable row level security;
revoke all on public.bank_pot_history from anon, authenticated;
grant select on public.bank_pot_history to authenticated;
grant all on public.bank_pot_history to service_role;
drop policy if exists "own bank data after two-step" on public.bank_pot_history;
create policy "own bank data after two-step" on public.bank_pot_history for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

create or replace function public.bank_pots_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare prev public.bank_pot_history;
begin
  if new.balance is null then return null; end if;
  select * into prev from public.bank_pot_history
    where user_id = new.user_id and pot_id = new.pot_id
    order by first_seen desc, id desc limit 1;
  if found and prev.balance = new.balance then
    update public.bank_pot_history set last_seen = greatest(last_seen, now()) where id = prev.id;
  else
    insert into public.bank_pot_history (user_id, pot_id, balance, first_seen, last_seen)
      values (new.user_id, new.pot_id, new.balance, now(), now());
    delete from public.bank_pot_history
      where user_id = new.user_id and pot_id = new.pot_id and last_seen < now() - interval '200 days';
  end if;
  return null;
end $$;
drop trigger if exists bank_pots_history on public.bank_pots;
create trigger bank_pots_history after insert or update on public.bank_pots
  for each row execute function public.bank_pots_history();
revoke all on function public.bank_pots_history() from public, anon, authenticated;

-- Start from the balances saved so far.
insert into public.bank_pot_history (user_id, pot_id, balance, first_seen, last_seen)
  select p.user_id, p.pot_id, p.balance, p.updated_at, p.updated_at from public.bank_pots p
  where p.balance is not null
    and not exists (select 1 from public.bank_pot_history h where h.user_id = p.user_id and h.pot_id = p.pot_id);

notify pgrst, 'reload schema';
