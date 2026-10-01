-- Vaulted ⇄ Monzo (v1.15.4): payees you've corrected. (Applied as bank_prefs_payees.)
-- By payee key ("m:<merchant>", "n:<name>", "dd:<mandate>", "pot:<pot>"): {regular: false} for one
-- that only looks like a regular payment (Lidl now and then), {name} to show it under another name
-- (a payment to Angie that's for Simon). Same rules as the rest of bank_prefs: your own row, two-step.
alter table public.bank_prefs add column if not exists payees jsonb not null default '{}'::jsonb;
notify pgrst, 'reload schema';
