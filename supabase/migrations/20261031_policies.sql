-- Vaulted v1.20.0: Policies — insurance, energy, broadband and anything else with a renewal date,
-- with their documents. (Applied as policies.)
--
-- Each login sees only its own, and only from a two-step session (like the Monzo data).
-- Documents live in the private "policies" bucket, in <user id>/<policy id>/ folders.

create table if not exists public.policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null default 'other',            -- car, home, pet, energy, broadband, mobile, …
  provider text,
  name text,                                     -- what it's for, e.g. "Kia Sportage"
  policy_number text,
  cover text,                                    -- what's covered, in a line or two
  start_date date,
  end_date date,                                 -- when it ends or renews
  price numeric(10,2),
  price_period text,                             -- month | year | once
  payment text,                                  -- how it's paid, e.g. "Direct Debit, monthly"
  auto_renew boolean,                            -- null = not sure
  phone text,
  website text,
  details jsonb not null default '[]'::jsonb,    -- [{label, value}]: excess, car reg, tariff, …
  prices jsonb not null default '[]'::jsonb,     -- price history, oldest first: [{date, price, period, from}]
  docs jsonb not null default '[]'::jsonb,       -- [{id, path, name, mime, size, kind, added}]
  notes text,
  archived boolean not null default false,       -- an old policy, kept for reference
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists policies_user_idx on public.policies (user_id);

alter table public.policies enable row level security;
revoke all on public.policies from anon, authenticated;
grant select, insert, update, delete on public.policies to authenticated;
grant all on public.policies to service_role;
drop policy if exists "own policies after two-step" on public.policies;
create policy "own policies after two-step" on public.policies for all to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2')
  with check (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- The documents: private, up to 20 MB each, PDFs and photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('policies', 'policies', false, 20971520, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "policies: read own documents" on storage.objects;
create policy "policies: read own documents" on storage.objects for select to authenticated
  using (bucket_id = 'policies' and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "policies: add own documents" on storage.objects;
create policy "policies: add own documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'policies' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "policies: change own documents" on storage.objects;
create policy "policies: change own documents" on storage.objects for update to authenticated
  using (bucket_id = 'policies' and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select auth.jwt() ->> 'aal') = 'aal2')
  with check (bucket_id = 'policies' and (storage.foldername(name))[1] = (select auth.uid())::text
              and (select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "policies: remove own documents" on storage.objects;
create policy "policies: remove own documents" on storage.objects for delete to authenticated
  using (bucket_id = 'policies' and (storage.foldername(name))[1] = (select auth.uid())::text
         and (select auth.jwt() ->> 'aal') = 'aal2');

notify pgrst, 'reload schema';
