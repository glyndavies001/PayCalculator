-- 3 Nov 2026 (run by Claude through the SQL tool): anyone in the household (a profiles row) can read the
-- energy tables with a normal sign-in, so Hollie sees the Energy page. Renaming plugs stays the owner's,
-- with two-step ("rename own plugs after two-step"). The old two-step read policies are still there
-- (dropping them needs Glyn to paste it: the SQL tool's confirmation closes itself on his phone); they're
-- covered by these and can go:
--   drop policy "own plugs after two-step" on public.energy_devices;
--   drop policy "own readings after two-step" on public.energy_readings;
--   drop policy "own plug days after two-step" on public.energy_days;
--   drop policy "own house days after two-step" on public.energy_house;
create policy "household reads plugs" on public.energy_devices for select to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid())));
create policy "household reads readings" on public.energy_readings for select to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid())));
create policy "household reads plug days" on public.energy_days for select to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid())));
create policy "household reads house days" on public.energy_house for select to authenticated using (exists (select 1 from public.profiles p where p.id = (select auth.uid())));
