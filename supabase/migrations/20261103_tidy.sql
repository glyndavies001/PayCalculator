-- Database tidy, 3 Nov 2026 (applied with the Supabase tool). The drops that go with it are in
-- 20261103_tidy_drops.sql, pasted into the SQL editor by hand.

-- A signed-in user can't change their own role (owner/partner); only the server can.
create or replace function public.lock_profile_role() returns trigger
language plpgsql set search_path = public as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    if tg_op = 'INSERT' then
      new.role := 'partner';
    elsif new.role is distinct from old.role then
      new.role := old.role;
    end if;
  end if;
  return new;
end $$;
create or replace trigger profiles_lock_role before insert or update on public.profiles
  for each row execute function public.lock_profile_role();

-- Indexes for foreign keys.
create index if not exists bank_hook_inbox_user_id_idx on public.bank_hook_inbox (user_id);
create index if not exists ct_dishes_user_id_idx on public.ct_dishes (user_id);
create index if not exists ct_foods_user_id_idx on public.ct_foods (user_id);
create index if not exists current_list_master_item_id_idx on public.current_list (master_item_id);
create index if not exists leave_logs_user_id_idx on public.leave_logs (user_id);
create index if not exists meal_ingredients_master_item_id_idx on public.meal_ingredients (master_item_id);
create index if not exists monthly_timesheets_user_id_idx on public.monthly_timesheets (user_id);
create index if not exists trips_shop_id_idx on public.trips (shop_id);

-- Fixed search path.
alter function public.prune_old_backups() set search_path = public;

-- Replacements for overlapping policies (the old ones are dropped in 20261103_tidy_drops.sql).
create policy "household" on public.shared_bills for all to authenticated using (true) with check (true);
create policy "profiles insert own" on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Same rules, but auth.uid()/auth.role() are worked out once per query instead of once per row.
alter policy "Users can manage own settings" on public.app_settings to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own backups" on public.backups to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own discrepancies" on public.discrepancies to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own leave" on public.leave_logs to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own leave settings" on public.leave_settings to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own timesheets" on public.monthly_timesheets to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own payslips" on public.payslips to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own scenarios" on public.scenarios to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own timesheet accumulator" on public.timesheet_accumulator to authenticated using ((select auth.uid()) = user_id);
alter policy "Users can manage own profile" on public.profiles to authenticated using ((select auth.uid()) = id);
alter policy "profiles read authenticated" on public.profiles to authenticated using (true);
alter policy "gifts rw" on public.gifts to authenticated using (true) with check (true);
alter policy "scheduled_bills rw" on public.scheduled_bills to authenticated using (true) with check (true);
alter policy "settlements rw" on public.settlements to authenticated using (true) with check (true);
alter policy "shared_settings rw" on public.shared_settings to authenticated using (true) with check (true);
alter policy "glyn_bills select" on public.glyn_bills to authenticated
  using (((select auth.uid()) = user_id) or ((select p.role from public.profiles p where p.id = (select auth.uid())) = 'owner'));
alter policy "glyn_bills update" on public.glyn_bills to authenticated
  using (((select auth.uid()) = user_id) or ((select p.role from public.profiles p where p.id = (select auth.uid())) = 'owner'));
alter policy "glyn_bills delete" on public.glyn_bills to authenticated
  using (((select auth.uid()) = user_id) or ((select p.role from public.profiles p where p.id = (select auth.uid())) = 'owner'));
alter policy "glyn_bills insert" on public.glyn_bills to authenticated
  with check (((select auth.uid()) = user_id) or ((select p.role from public.profiles p where p.id = (select auth.uid())) = 'owner'));
