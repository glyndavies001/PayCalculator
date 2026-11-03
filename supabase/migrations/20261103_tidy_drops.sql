-- Database tidy, 3 Nov 2026: the drops. Paste into Supabase → SQL Editor → Run, once.
-- Safe to run again (if exists). Everything here has a replacement already in place.
begin;
-- Duplicate indexes (each has an identical twin that stays)
drop index if exists public.app_settings_user_uidx;
drop index if exists public.glyn_bills_bill_id_uidx;
drop index if exists public.leave_settings_user_uidx;
drop index if exists public.monthly_ts_email_uidx;
drop index if exists public.payslips_user_month_uidx;
drop index if exists public.scenarios_user_name_uidx;
drop index if exists public.shared_bills_bill_id_uidx;
drop index if exists public.accumulator_user_uidx;
-- Old Energy rules (the household ones replace them)
drop policy if exists "own plug days after two-step" on public.energy_days;
drop policy if exists "own plugs after two-step" on public.energy_devices;
drop policy if exists "own house days after two-step" on public.energy_house;
drop policy if exists "own readings after two-step" on public.energy_readings;
-- Shared bills: six overlapping rules, replaced by "household"
drop policy if exists "All authenticated users can read shared bills" on public.shared_bills;
drop policy if exists "Owner can manage shared bills" on public.shared_bills;
drop policy if exists "shared_bills delete" on public.shared_bills;
drop policy if exists "shared_bills insert" on public.shared_bills;
drop policy if exists "shared_bills select" on public.shared_bills;
drop policy if exists "shared_bills update" on public.shared_bills;
-- Profiles: replaced by "profiles insert own" and "profiles update own"
drop policy if exists "Users can manage own profile" on public.profiles;
commit;
