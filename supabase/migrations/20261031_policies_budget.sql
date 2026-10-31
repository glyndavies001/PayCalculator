-- Vaulted v1.21.0: a policy can be linked to its Budget bill. (Applied as policies_budget_link.)
-- bill_ref is the bill's key, like the Monzo links: "s:<shared bill id>" or "g:<personal bill id>".
-- bill_part = the bill covers other things too (one Utility Warehouse bill for energy, broadband and
-- boiler cover, say), so its amount isn't checked against the policy's price.
alter table public.policies add column if not exists bill_ref text, add column if not exists bill_part boolean not null default false;
notify pgrst, 'reload schema';
