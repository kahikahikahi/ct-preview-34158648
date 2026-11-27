-- Keep the public wrapper as SECURITY INVOKER (same as before).
-- It calls private.expire_sold_out (DEFINER, tight update) then private.place_order (already DEFINER).
-- private schema is not exposed via the Data API, so expire is not a public RPC.

create or replace function public.place_order(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform private.expire_sold_out();
  return private.place_order(payload);
end;
$$;

revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to anon, authenticated;

grant execute on function private.expire_sold_out() to anon, authenticated;
