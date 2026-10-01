-- Vaulted ⇄ Monzo (v1.15.1): money Monzo has taken but not listed yet.
-- (Applied as bank_gap.)
--
-- Monzo takes some direct debits off the balance early in the morning but only lists them later,
-- so "still to go" counted them twice. For each account we keep
--   gap_offset = balance − (sum of the transactions we hold)
-- which stays the same while the list is complete (it's the balance before the first transaction
-- we hold). gap_base is its settled value: one that has held for 24 hours. The app reads
--   gap_base − gap_offset
-- as money taken but not listed yet. A change that lasts (a card hold Monzo released, say) becomes
-- the new base the next day. Worked out whenever a balance or transactions are saved.

alter table public.bank_accounts add column if not exists gap_offset bigint;
alter table public.bank_accounts add column if not exists gap_changed_at timestamptz;
alter table public.bank_accounts add column if not exists gap_base bigint;

create or replace function public.bank_gap_next(acc public.bank_accounts) returns public.bank_accounts
language plpgsql set search_path = public as $$
declare listed bigint; off bigint;
begin
  if acc.balance is null then return acc; end if;
  select coalesce(sum(amount), 0) into listed from public.bank_transactions
    where user_id = acc.user_id and account_id = acc.account_id;
  off := acc.balance - listed;
  if acc.gap_offset is distinct from off then
    acc.gap_offset := off;
    acc.gap_changed_at := now();
  elsif acc.gap_changed_at is not null and now() - acc.gap_changed_at >= interval '24 hours' then
    acc.gap_base := off;
  end if;
  return acc;
end $$;

-- A balance saved: work it out for that account.
create or replace function public.bank_accounts_gap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  return public.bank_gap_next(new);
end $$;
drop trigger if exists bank_accounts_gap on public.bank_accounts;
create trigger bank_accounts_gap before insert or update of balance on public.bank_accounts
  for each row execute function public.bank_accounts_gap();

-- Transactions saved: work it out for each account they're on.
create or replace function public.bank_transactions_gap() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; n public.bank_accounts;
begin
  for r in select distinct user_id, account_id from new_rows loop
    select * into n from public.bank_accounts where user_id = r.user_id and account_id = r.account_id;
    if not found then continue; end if;
    n := public.bank_gap_next(n);
    update public.bank_accounts set gap_offset = n.gap_offset, gap_changed_at = n.gap_changed_at, gap_base = n.gap_base
      where user_id = r.user_id and account_id = r.account_id;
  end loop;
  return null;
end $$;
drop trigger if exists bank_transactions_gap_ins on public.bank_transactions;
create trigger bank_transactions_gap_ins after insert on public.bank_transactions
  referencing new table as new_rows for each statement execute function public.bank_transactions_gap();
drop trigger if exists bank_transactions_gap_upd on public.bank_transactions;
create trigger bank_transactions_gap_upd after update on public.bank_transactions
  referencing new table as new_rows for each statement execute function public.bank_transactions_gap();

revoke all on function public.bank_gap_next(public.bank_accounts) from public, anon, authenticated;
revoke all on function public.bank_accounts_gap() from public, anon, authenticated;
revoke all on function public.bank_transactions_gap() from public, anon, authenticated;

-- Start from today's figures. The personal account's list is complete; the joint account is
-- missing this morning's UW and Hyundai Finance (£619.81 taken at about 05:50, not listed yet:
-- its balance was £2,230.27 on 30 Sep and only £1,392.49 has been listed since).
update public.bank_accounts set balance = balance;   -- fills gap_offset
update public.bank_accounts a set gap_base = a.gap_offset + case
    when a.type = 'uk_retail_joint' and a.balance = 21797
     and (select coalesce(sum(t.amount), 0) from public.bank_transactions t
          where t.user_id = a.user_id and t.account_id = a.account_id and t.created >= '2026-10-01 00:00+01') = -139249
    then 61981 else 0 end
  where a.user_id = '374456f0-e57a-4c5b-b690-98889745fcee' and not a.closed;

notify pgrst, 'reload schema';
