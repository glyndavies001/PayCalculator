-- Vaulted v1.24.0: what each Claude read costs, and the Claude credit reminder.
-- ai_usage: one row per Claude request that was billed (and one per "credit balance too low" refusal),
-- written by /api/claude with the signed-in user's own token, or by the app for timesheet emails
-- (ref = 'email:<id>' so an email is only counted once). cost_usd uses the model's list price.
-- ai_credit: the balance and expiry date Glyn copies from the Anthropic Billing page; what's left is
-- balance_usd less everything in ai_usage since balance_at.

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  source text not null default 'other',
  model text not null,
  asked_model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  error text,
  ref text unique
);
create index if not exists ai_usage_at_idx on public.ai_usage (at);
create index if not exists ai_usage_user_idx on public.ai_usage (user_id);
alter table public.ai_usage enable row level security;
drop policy if exists "read own AI use, or all for the owner" on public.ai_usage;
create policy "read own AI use, or all for the owner" on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid())
         or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'owner'));
drop policy if exists "log own AI use" on public.ai_usage;
create policy "log own AI use" on public.ai_usage for insert to authenticated
  with check (user_id = (select auth.uid()));

create table if not exists public.ai_credit (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  balance_usd numeric(10,2) not null,
  balance_at timestamptz not null default now(),
  expires_on date,
  updated_at timestamptz not null default now()
);
alter table public.ai_credit enable row level security;
drop policy if exists "own credit details" on public.ai_credit;
create policy "own credit details" on public.ai_credit for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
