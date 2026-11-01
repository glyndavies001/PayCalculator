-- Vaulted v1.22.0: Energy — the smart plugs (Shelly) and the whole house (Bright). (Applied as energy.)
--
-- The energy function reads each plug from Shelly's cloud every 15 minutes (and when the Energy
-- page is open), and the house's half-hourly electricity from Bright a few times a day. Each login
-- sees only its own rows, and only from a two-step session (like Policies). The Shelly key and the
-- Bright login stay server-side: the app can't read them.
-- Safe to run again.

-- The function's own settings (the scheduler's key).
create table if not exists public.energy_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.energy_config enable row level security;
revoke all on public.energy_config from anon, authenticated;
grant all on public.energy_config to service_role;
insert into public.energy_config (key, value)
values ('cron_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- Each person's Shelly key and Bright login.
create table if not exists public.energy_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  shelly_server text,
  shelly_key text,
  shelly_linked_at timestamptz,
  shelly_checked_at timestamptz,
  shelly_error text,
  bright_user text,
  bright_pass text,
  bright_token text,
  bright_token_exp timestamptz,
  bright_resource text,                      -- the smart meter's electricity use
  bright_linked_at timestamptz,
  bright_checked_at timestamptz,
  bright_error text,
  updated_at timestamptz not null default now()
);
alter table public.energy_links enable row level security;
revoke all on public.energy_links from anon, authenticated;
grant all on public.energy_links to service_role;

-- The plugs. The name and icon are the person's own; the latest reading is kept on the row.
create table if not exists public.energy_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  shelly_id text not null,                   -- Shelly's Device ID
  name text not null default 'Plug',
  icon text,                                 -- computer | treadmill | aircon | other
  model text,                                -- e.g. SNPL-00112UK
  sort int not null default 0,
  hidden boolean not null default false,     -- not read or shown
  online boolean,
  is_on boolean,
  watts real,
  total_wh double precision,                 -- the plug's own running total (Wh)
  read_at timestamptz,                       -- when total_wh was read
  created_at timestamptz not null default now(),
  unique (user_id, shelly_id)
);
create index if not exists energy_devices_user_idx on public.energy_devices (user_id);
alter table public.energy_devices enable row level security;
revoke all on public.energy_devices from anon, authenticated;
grant select on public.energy_devices to authenticated;
grant update (name, icon, sort, hidden) on public.energy_devices to authenticated;
grant all on public.energy_devices to service_role;
drop policy if exists "own plugs after two-step" on public.energy_devices;
create policy "own plugs after two-step" on public.energy_devices for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');
drop policy if exists "rename own plugs after two-step" on public.energy_devices;
create policy "rename own plugs after two-step" on public.energy_devices for update to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2')
  with check (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- Every reading of a plug.
create table if not exists public.energy_readings (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.energy_devices (id) on delete cascade,
  at timestamptz not null,
  watts real,
  total_wh double precision not null,
  is_on boolean
);
create index if not exists energy_readings_device_at_idx on public.energy_readings (device_id, at);
create index if not exists energy_readings_user_at_idx on public.energy_readings (user_id, at);
alter table public.energy_readings enable row level security;
revoke all on public.energy_readings from anon, authenticated;
grant select on public.energy_readings to authenticated;
grant all on public.energy_readings to service_role;
drop policy if exists "own readings after two-step" on public.energy_readings;
create policy "own readings after two-step" on public.energy_readings for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- Each plug's use per UK day, added up as readings come in.
create table if not exists public.energy_days (
  device_id uuid not null references public.energy_devices (id) on delete cascade,
  day date not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  wh double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (device_id, day)
);
create index if not exists energy_days_user_day_idx on public.energy_days (user_id, day);
alter table public.energy_days enable row level security;
revoke all on public.energy_days from anon, authenticated;
grant select on public.energy_days to authenticated;
grant all on public.energy_days to service_role;
drop policy if exists "own plug days after two-step" on public.energy_days;
create policy "own plug days after two-step" on public.energy_days for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- The whole house, from Bright: each UK day's electricity and how many of its half-hours that
-- covers (48 on most days; 46 and 50 when the clocks change).
create table if not exists public.energy_house (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  kwh numeric(10, 3) not null,
  halves int not null,
  fetched_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.energy_house enable row level security;
revoke all on public.energy_house from anon, authenticated;
grant select on public.energy_house to authenticated;
grant all on public.energy_house to service_role;
drop policy if exists "own house days after two-step" on public.energy_house;
create policy "own house days after two-step" on public.energy_house for select to authenticated
  using (user_id = (select auth.uid()) and (select auth.jwt() ->> 'aal') = 'aal2');

-- One reading of one plug: kept, and the use since the plug's last reading added to its days
-- (split across midnight by time). A drop in the plug's total means it restarted its count, so
-- the new total is what it's used since. A reading at or before the last one is ignored, so two
-- reads at once can't count anything twice. Only the energy function calls this.
create or replace function public.energy_ingest(p_device uuid, p_at timestamptz, p_watts real,
                                                p_total double precision, p_on boolean)
returns double precision
language plpgsql
set search_path = public
as $$
declare
  d public.energy_devices%rowtype;
  used double precision := 0;
  span double precision;
  cur date;
  last_day date;
  part double precision;
begin
  select * into d from public.energy_devices where id = p_device for update;
  if not found then return 0; end if;
  if d.read_at is not null and p_at <= d.read_at then return 0; end if;
  insert into public.energy_readings (user_id, device_id, at, watts, total_wh, is_on)
  values (d.user_id, p_device, p_at, p_watts, p_total, p_on);
  if d.read_at is not null and d.total_wh is not null then
    used := p_total - d.total_wh;
    if used < -0.5 then used := p_total;
    elsif used < 0 then used := 0;
    end if;
    -- More than a 13A plug could use in the time (4 kW flat out) is a glitch, not use.
    if used > 4000 * extract(epoch from (p_at - d.read_at)) / 3600 then used := 0; end if;
  end if;
  if used > 0 then
    span := extract(epoch from (p_at - d.read_at));   -- > 0: p_at is after read_at
    cur := (d.read_at at time zone 'Europe/London')::date;
    last_day := (p_at at time zone 'Europe/London')::date;
    loop
      -- This day's share of the time since the last reading. Over a year offline: all on today.
      part := case when last_day - cur > 400 then used
        else used * extract(epoch from (
               least(p_at, ((cur + 1)::timestamp at time zone 'Europe/London'))
               - greatest(d.read_at, (cur::timestamp at time zone 'Europe/London')))) / span end;
      if last_day - cur > 400 then cur := last_day; end if;
      if part > 0 then
        insert into public.energy_days (device_id, day, user_id, wh, updated_at)
        values (p_device, cur, d.user_id, part, now())
        on conflict (device_id, day) do update set wh = public.energy_days.wh + excluded.wh, updated_at = now();
      end if;
      exit when cur >= last_day;
      cur := cur + 1;
    end loop;
  end if;
  update public.energy_devices
  set total_wh = p_total, read_at = p_at, watts = p_watts, is_on = p_on, online = true
  where id = p_device;
  return used;
end $$;
revoke all on function public.energy_ingest(uuid, timestamptz, real, double precision, boolean) from public, anon, authenticated;
grant execute on function public.energy_ingest(uuid, timestamptz, real, double precision, boolean) to service_role;

-- Bright's days for one person: a day only changes when the new figure covers at least as many
-- half-hours, so a read that starts part-way through a day can't shrink it.
create or replace function public.energy_house_put(p_user uuid, p_days jsonb)
returns int
language sql
set search_path = public
as $$
  with x as (
    select (e ->> 'day')::date as day, (e ->> 'kwh')::numeric as kwh, (e ->> 'halves')::int as halves
    from jsonb_array_elements(p_days) e
  ), up as (
    insert into public.energy_house (user_id, day, kwh, halves, fetched_at)
    select p_user, day, kwh, halves, now() from x where halves > 0
    on conflict (user_id, day) do update set kwh = excluded.kwh, halves = excluded.halves, fetched_at = now()
    where excluded.halves >= public.energy_house.halves
    returning 1
  )
  select count(*)::int from up
$$;
revoke all on function public.energy_house_put(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.energy_house_put(uuid, jsonb) to service_role;

-- Every 15 minutes, once someone has linked Shelly or Bright.
select cron.schedule('energy-poll', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://yfbarahnwcrwewtpithb.supabase.co/functions/v1/energy',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-key', (select value from public.energy_config where key = 'cron_key')),
    body := '{"action":"cron"}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (select 1 from public.energy_links where shelly_key is not null or bright_user is not null);
$cron$);

notify pgrst, 'reload schema';
