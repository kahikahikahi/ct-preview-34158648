-- Staff tablet: change item quantities, remove items, and notes on a new order.
-- SECURITY DEFINER so we can update order_items (staff have SELECT only).
-- Requires is_staff(). Paid orders cannot be edited (avoids changing a charged total).
create or replace function public.edit_order(p_order_id uuid, p_items jsonb, p_notes text default null)
returns table (id uuid, ref text, total_cents integer, notes text)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_status text;
  v_pay_method text;
  v_pay_status text;
  v_total int := 0;
  v_notes text := private.clean_text(p_notes, 500);
  v_row jsonb;
  v_item_id bigint;
  v_qty int;
  v_note text;
  v_unit int;
  v_seen bigint[] := '{}';
  v_count int;
begin
  if not private.is_staff() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Please send the items to keep.' using errcode = '22023';
  end if;

  select o.status, o.payment_method, o.payment_status
    into v_status, v_pay_method, v_pay_status
    from public.orders o
   where o.id = p_order_id
   for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status <> 'new' then
    raise exception 'Only a new order can be edited.' using errcode = '22023';
  end if;
  if v_pay_status = 'paid' then
    raise exception 'A paid order can''t be edited.' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_items)
  loop
    v_item_id := (v_row->>'id')::bigint;
    v_qty := coalesce((v_row->>'qty')::int, 0);
    v_note := private.clean_text(v_row->>'note', 200);
    if v_item_id is null then
      raise exception 'Each item needs an id.' using errcode = '22023';
    end if;
    if v_qty < 1 or v_qty > 99 then
      raise exception 'Quantity must be between 1 and 99.' using errcode = '22023';
    end if;
    select i.unit_cents into v_unit
      from public.order_items i
     where i.id = v_item_id and i.order_id = p_order_id;
    if not found then
      raise exception 'That item is not on this order.' using errcode = 'P0002';
    end if;
    if v_item_id = any (v_seen) then
      raise exception 'Duplicate item.' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_item_id);
    update public.order_items i
       set qty = v_qty,
           note = v_note,
           line_cents = v_unit * v_qty
     where i.id = v_item_id;
    v_total := v_total + (v_unit * v_qty);
  end loop;

  if coalesce(array_length(v_seen, 1), 0) < 1 then
    raise exception 'An order needs at least one item.' using errcode = '22023';
  end if;

  delete from public.order_items i
   where i.order_id = p_order_id
     and not (i.id = any (v_seen));

  select count(*)::int into v_count from public.order_items i where i.order_id = p_order_id;
  if v_count < 1 then
    raise exception 'An order needs at least one item.' using errcode = '22023';
  end if;

  update public.orders o
     set total_cents = v_total,
         notes = v_notes
   where o.id = p_order_id;

  return query
    select o.id, o.ref, o.total_cents, o.notes
      from public.orders o
     where o.id = p_order_id;
end;
$function$;

revoke all on function public.edit_order(uuid, jsonb, text) from public, anon;
grant execute on function public.edit_order(uuid, jsonb, text) to authenticated;
