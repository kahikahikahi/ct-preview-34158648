-- Edge Functions create-checkout and stripe-webhook need to load an order and
-- update payment fields using the service role. Table grants were not given to
-- service_role (only REFERENCES/TRIGGER/TRUNCATE). This does not change RLS
-- for anon or authenticated, and does not grant INSERT or DELETE.
grant select on public.orders to service_role;
grant select on public.order_items to service_role;
grant update (payment_status, payment_ref, updated_at) on public.orders to service_role;
