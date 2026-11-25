-- Accept real NZ mobiles 020/021/022/027/028/029 (and +64, spaces, dashes).
-- Tighten prefixes vs the earlier 2[0-9] catch-all. Do not change RLS.
create or replace function private.canonical_phone(p text)
returns text
language plpgsql
immutable
set search_path to ''
as $function$
declare
  n text;
begin
  if p is null then
    return null;
  end if;
  n := regexp_replace(btrim(p), '[ \t\-\.\(\)]', '', 'g');
  if n ~ '^00[1-9]' then
    n := '+' || substr(n, 3);
  end if;
  -- Bare NZ forms → E.164. Other countries must already have + or 00.
  if n ~ '^64(2[012789][0-9]{6,8}|[34679][0-9]{7})$' then
    n := '+' || n;
  elsif n ~ '^0(2[012789][0-9]{6,8}|[34679][0-9]{7})$' then
    n := '+64' || substr(n, 2);
  end if;
  if n ~ '^\+[1-9][0-9]{7,14}$' then
    return n;
  end if;
  return null;
end;
$function$;

create or replace function private.valid_phone(p text)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  n text;
  rest text;
  area text;
begin
  n := private.canonical_phone(p);
  if n is null then
    return false;
  end if;

  if n like '+64%' then
    rest := substr(n, 4);
    if rest ~ '^2[012789][0-9]{6,8}$' then return true; end if;
    if rest ~ '^[34679][0-9]{7}$' then return true; end if;
    return false;
  end if;

  if n like '+61%' then
    rest := substr(n, 4);
    if rest ~ '^4[0-9]{8}$' then return true; end if;
    if rest ~ '^[2378][0-9]{8}$' then return true; end if;
    return false;
  end if;

  if n like '+1%' then
    if n !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' then return false; end if;
    area := substring(n from 3 for 3);
    if area ~ '^[2-9]11$' or area ~ '^[2-9]00$' then return false; end if;
    return true;
  end if;

  rest := substr(n, 2);
  if rest ~ '^([0-9])\1+$' then return false; end if;
  if rest ~ '0{7,}$' then return false; end if;
  return true;
end;
$function$;

comment on function private.valid_phone(text) is
  'Canonicalises spaces/dashes/+64/leading-0 NZ, then checks country rules. NZ mobiles only 020/021/022/027/028/029 at 8–10 digit NSN.';
