-- Sold-out is "for today" (NZ): staff mark an item sold out, it comes back on after midnight.
-- place_order still refuses sold-out items (after expiring yesterday's marks).
-- Staff can mark an accepted order as picked up (collected).

alter table public.menu_items
  add column if not exists sold_out_on date;

comment on column public.menu_items.sold_out_on is
  'NZ calendar date the item was marked sold out. Null with active=false means until staff switch it back on. A past date is treated as available and is cleared by expire_sold_out.';

grant select (sold_out_on) on public.menu_items to anon, authenticated;
grant update (sold_out_on) on public.menu_items to authenticated;

create or replace function private.cafe_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (private.cafe_now() at time zone 'Pacific/Auckland')::date;
$$;

-- Tightly scoped: only clears dated sold-out marks from a previous NZ day.
create or replace function private.expire_sold_out()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.menu_items
     set active = true,
         sold_out_on = null
   where sold_out_on is not null
     and sold_out_on < private.cafe_today();
end;
$$;

create or replace function private.item_is_sold_out(p_active boolean, p_sold_out_on date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (not coalesce(p_active, true))
     and (p_sold_out_on is null or p_sold_out_on = private.cafe_today());
$$;

revoke all on function private.cafe_today(), private.expire_sold_out(), private.item_is_sold_out(boolean, date)
  from public, anon, authenticated;

-- Run expiry before the existing active check in private.place_order.
create or replace function public.place_order(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.expire_sold_out();
  return private.place_order(payload);
end;
$$;

revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to anon, authenticated;

-- Staff can also flush yesterday's marks when they open the menu list.
create or replace function public.expire_sold_out()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not private.is_staff() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  perform private.expire_sold_out();
end;
$$;

revoke all on function public.expire_sold_out() from public, anon;
grant execute on function public.expire_sold_out() to authenticated;

create or replace function public.collect_order(p_order_id uuid)
returns table (id uuid, ref text, status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  if not private.is_staff() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select o.status into v_status from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status = 'collected' then
    raise exception 'This order is already marked picked up.' using errcode = 'P0002';
  end if;
  if v_status not in ('accepted', 'preparing', 'ready') then
    raise exception 'Accept the order before marking it picked up.' using errcode = '22023';
  end if;
  return query
    update public.orders o
       set status = 'collected'
     where o.id = p_order_id
       and o.status in ('accepted', 'preparing', 'ready')
    returning o.id, o.ref, o.status;
end;
$$;

revoke all on function public.collect_order(uuid) from public, anon;
grant execute on function public.collect_order(uuid) to authenticated;
