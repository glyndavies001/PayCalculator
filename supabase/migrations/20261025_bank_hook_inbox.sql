-- Vaulted ⇄ Monzo: notifications the bank function couldn't place on a linked account.
--
-- Monzo sends a notification the moment a card payment is taken straight from a pot, but it
-- doesn't arrive under the personal or joint account, so the function used to drop it. It's
-- kept here instead (store name, amount, time, pot details) so pot payments can be matched to
-- a Trolley shop. Server-only: nobody can read it from the apps. Rows go after 60 days, and when
-- the person unlinks Monzo.

create table if not exists public.bank_hook_inbox (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  user_id uuid references public.bank_links (user_id) on delete cascade,   -- when known
  why text,                 -- why it couldn't be placed
  type text,                -- Monzo's event type
  tx_id text,
  account_id text,
  created timestamptz,      -- when the payment was made
  amount bigint,            -- pence (negative = money out)
  currency text,
  description text,
  merchant text,            -- the store's name, when Monzo gives one
  category text,
  scheme text,
  pot_id text,
  meta jsonb                -- field names sent, Monzo's metadata, merchant id, any decline (trimmed)
);
create index if not exists bank_hook_inbox_received_idx on public.bank_hook_inbox (received_at desc);
-- Monzo can send the same notification more than once: keep one row per payment.
create unique index if not exists bank_hook_inbox_tx_idx on public.bank_hook_inbox (tx_id);

alter table public.bank_hook_inbox enable row level security;
revoke all on public.bank_hook_inbox from anon, authenticated;
grant all on public.bank_hook_inbox to service_role;

notify pgrst, 'reload schema';
