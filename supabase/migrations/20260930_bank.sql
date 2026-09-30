-- Vaulted ⇄ Monzo (read-only).
-- Keys and tokens are server-only. Bank data can be read only by the person it belongs to,
-- and only from a session that has passed two-step (aal2). Only the bank edge function writes.

create table if not exists public.bank_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.bank_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  monzo_user_id text,
  access_token text,
  refresh_token text,
  access_expires timestamptz,
  pending_state text unique,
  pending_at timestamptz,
  authorised_at timestamptz,      -- code exchanged; Monzo then wants approval in its app
  approved_at timestamptz,        -- approval seen (Monzo asks again every 90 days)
  full_history boolean not null default false,
  status text,                    -- approve | ok | reauth
  last_sync_at timestamptz,
  last_error text,
  linked_at timestamptz,
  webhook_ids jsonb,
  sync_lock timestamptz
);

create table if not exists public.bank_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id text not null,
  type text,
  description text,
  closed boolean not null default false,
  balance bigint,                 -- pence, excluding pots
  total_balance bigint,           -- pence, including pots
  spend_today bigint,
  currency text,
  updated_at timestamptz not null default now(),
  primary key (user_id, account_id)
);
create index if not exists bank_accounts_account_idx on public.bank_accounts (account_id);

create table if not exists public.bank_pots (
  user_id uuid not null references auth.users(id) on delete cascade,
  pot_id text not null,
  account_id text,
  name text,
  balance bigint,
  goal_amount bigint,
  currency text,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, pot_id)
);

create table if not exists public.bank_transactions (
  user_id uuid not null references auth.users(id) on delete cascade,
  tx_id text not null,
  account_id text not null,
  created timestamptz not null,
  settled timestamptz,
  amount bigint not null,         -- pence, negative = money out
  currency text,
  description text,
  merchant text,
  merchant_id text,
  counterparty text,
  category text,
  scheme text,
  pot_id text,                    -- set on moves to and from pots
  dd_id text,                     -- direct debit mandate
  include_in_spending boolean,
  updated_at timestamptz not null default now(),
  primary key (user_id, tx_id)
);
create index if not exists bank_transactions_recent_idx on public.bank_transactions (user_id, created desc);

-- Server-only: RLS on, no policies, no access for the app's roles.
alter table public.bank_config enable row level security;
alter table public.bank_links enable row level security;
revoke all on public.bank_config, public.bank_links from anon, authenticated;

-- Bank data: read-only, own rows, two-step sessions only.
alter table public.bank_accounts enable row level security;
alter table public.bank_pots enable row level security;
alter table public.bank_transactions enable row level security;
revoke all on public.bank_accounts, public.bank_pots, public.bank_transactions from anon, authenticated;
grant select on public.bank_accounts, public.bank_pots, public.bank_transactions to authenticated;

drop policy if exists "own bank data after two-step" on public.bank_accounts;
create policy "own bank data after two-step" on public.bank_accounts for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "own bank data after two-step" on public.bank_pots;
create policy "own bank data after two-step" on public.bank_pots for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "own bank data after two-step" on public.bank_transactions;
create policy "own bank data after two-step" on public.bank_transactions for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

grant all on public.bank_config, public.bank_links, public.bank_accounts, public.bank_pots, public.bank_transactions to service_role;

notify pgrst, 'reload schema';

-- ── Scheduler (applied separately as bank_schedule) ──────────────────────────
-- While someone is approving Vaulted in the Monzo app: check every minute, so the full history is
-- fetched inside Monzo's five-minute window even if the app is in the background.
-- select cron.schedule('bank-approval-watch', '* * * * *', $job$
--   select net.http_post(url := 'https://yfbarahnwcrwewtpithb.supabase.co/functions/v1/bank',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select value from public.bank_config where key = 'cron_key')),
--     body := '{"action":"cron_pending"}'::jsonb, timeout_milliseconds := 60000)
--   where exists (select 1 from public.bank_links where status = 'approve' and refresh_token is not null and authorised_at > now() - interval '20 minutes')
--     and exists (select 1 from public.bank_config where key = 'cron_key');
-- $job$);
-- Once a day (06:07 UK summer time): balances, pots, the last week of transactions, webhooks, tokens.
-- select cron.schedule('bank-daily', '7 5 * * *', $job$ … body := '{"action":"cron"}' …
--   where exists (select 1 from public.bank_links where refresh_token is not null) and exists (… cron_key …); $job$);

-- ── Hardening after review (applied as bank_link_hardening) ───────────────────
alter table public.bank_links add column if not exists refresh_lock timestamptz;   -- token refreshes take turns
alter table public.bank_links add column if not exists monzo_name text;            -- whose Monzo it is, for display
create unique index if not exists bank_links_monzo_user_uniq on public.bank_links (monzo_user_id) where monzo_user_id is not null;
alter table public.bank_accounts add constraint bank_accounts_link_fk foreign key (user_id) references public.bank_links (user_id) on delete cascade;
alter table public.bank_pots add constraint bank_pots_link_fk foreign key (user_id) references public.bank_links (user_id) on delete cascade;
alter table public.bank_transactions add constraint bank_transactions_link_fk foreign key (user_id) references public.bank_links (user_id) on delete cascade;
-- Only Glyn can set the Monzo keys: a fixed id kept server-side (profiles.role is not trusted).
insert into public.bank_config (key, value) values ('owner_id', '374456f0-e57a-4c5b-b690-98889745fcee')
  on conflict (key) do update set value = excluded.value, updated_at = now();
-- Nobody can change their own role (or create/delete profiles) from the apps; they only read it.
revoke insert, update, delete, truncate, references, trigger on public.profiles from anon, authenticated;
notify pgrst, 'reload schema';
