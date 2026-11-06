-- =====================================================================
-- OCC Ops Dashboard - Supabase database schema + security rules
-- =====================================================================
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- It is safe to run on a brand-new project. It recreates every rule the
-- old Node server enforced, but inside the database itself (Row Level
-- Security), so the rules hold no matter how someone talks to the API:
--
--   * Only logged-in, ACTIVE accounts can read or write anything.
--   * shift_user    -> can log records and edit only their OWN records.
--   * duty_manager  -> can edit and delete ANY record.
--   * admin         -> everything above + manage user accounts.
--   * "Entered by" is always stamped from the logged-in account and can't
--     be forged or changed afterwards.
--   * Anonymous visitors (no login) get nothing at all.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Reference data (edit these rows in Table Editor to change the lists)
-- ---------------------------------------------------------------------
create table if not exists public.aocs (
  code text primary key,
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true
);

create table if not exists public.categories (
  code text primary key,
  name text not null,
  sort_order integer not null default 0
);

create table if not exists public.delay_reason_tags (
  code text primary key,
  name text not null,
  sort_order integer not null default 0
);

insert into public.aocs (code, name, sort_order) values
  ('G9','G9',0), ('E5','E5',1), ('3L','3L',2), ('3O','3O',3), ('9P','9P',4), ('4P','4P',5)
on conflict (code) do update set name = excluded.name, sort_order = excluded.sort_order;

insert into public.categories (code, name, sort_order) values
  ('DELAY','Delay',0), ('GTB','GTB (Ground Turn Back)',1), ('ATB','ATB (Air Turn Back)',2),
  ('INCIDENT','Incident',3), ('DIVERSION','Diversion',4)
on conflict (code) do update set name = excluded.name, sort_order = excluded.sort_order;

insert into public.delay_reason_tags (code, name, sort_order) values
  ('TECHNICAL','Technical / AOG',0), ('ATC','ATC / Slot',1), ('WEATHER','Weather',2),
  ('CREW','Crew',3), ('PAX_BAGGAGE','Pax & Baggage',4), ('GROUND_HANDLING','Ground Handling / Ramp',5),
  ('LATE_INBOUND','Late Inbound / Rotational',6), ('OPERATIONAL','Operational',7), ('OTHER','Other',8)
on conflict (code) do update set name = excluded.name, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- User profiles (one row per login in Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9._-]{2,40}$'),
  full_name text not null check (length(full_name) between 1 and 120),
  role text not null default 'shift_user' check (role in ('shift_user','duty_manager','admin')),
  aoc text references public.aocs(code),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Operational data
-- ---------------------------------------------------------------------
create table if not exists public.delay_records (
  id bigint generated always as identity primary key,
  record_date date not null,
  shift text not null default '',
  aoc text not null references public.aocs(code),
  category text not null references public.categories(code),
  flight_number text check (length(flight_number) <= 200),
  route text check (length(route) <= 200),
  registration text check (length(registration) <= 100),
  reason text not null check (length(btrim(reason)) between 1 and 5000),
  reason_clean text check (length(reason_clean) <= 5000),
  delay_minutes integer check (delay_minutes is null or delay_minutes between 0 and 100000),
  downstream_impact text check (length(downstream_impact) <= 5000),
  status text not null default 'closed',
  batch_id text check (length(batch_id) <= 100),
  flights_free_text text check (length(flights_free_text) <= 5000),
  entered_by text,
  entered_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_delay_records_date_aoc on public.delay_records(record_date, aoc);
create index if not exists idx_delay_records_batch on public.delay_records(batch_id);
create index if not exists idx_delay_records_created on public.delay_records(created_at);

create table if not exists public.delay_breakdown_items (
  id bigint generated always as identity primary key,
  delay_record_id bigint not null references public.delay_records(id) on delete cascade,
  reason_tag text not null references public.delay_reason_tags(code),
  minutes integer not null default 0 check (minutes between 0 and 100000),
  note text check (length(note) <= 2000),
  note_clean text check (length(note_clean) <= 2000),
  sort_order integer not null default 0
);
create index if not exists idx_breakdown_record on public.delay_breakdown_items(delay_record_id);

create table if not exists public.aircraft_defects (
  id bigint generated always as identity primary key,
  record_date date not null,
  aoc text not null references public.aocs(code),
  defect_count integer not null default 0 check (defect_count between 0 and 100000),
  notes text check (length(notes) <= 2000),
  entered_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_date, aoc)
);

create table if not exists public.flight_counts (
  id bigint generated always as identity primary key,
  record_date date not null,
  aoc text not null references public.aocs(code),
  pax_flights integer not null default 0 check (pax_flights between 0 and 100000),
  entered_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (record_date, aoc)
);

-- ---------------------------------------------------------------------
-- Helper functions used by the security rules
-- ---------------------------------------------------------------------
-- Role of the logged-in user, or NULL if not logged in / deactivated.
create or replace function public.my_role()
returns text language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active)
$$;

create or replace function public.my_full_name()
returns text language sql stable security definer set search_path = ''
as $$
  select p.full_name from public.profiles p where p.id = auth.uid()
$$;

-- Same rule as the old server: author, duty manager or admin may edit.
create or replace function public.can_edit_record(p_record_id bigint)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.delay_records r
    where r.id = p_record_id
      and (
        public.my_role() in ('duty_manager','admin')
        or (public.my_role() = 'shift_user' and r.entered_by_user_id = auth.uid())
      )
  )
$$;

-- ---------------------------------------------------------------------
-- New login -> profile. Accounts start INACTIVE (no access) unless created
-- by an admin through the admin-users function, which activates them.
-- The very first account ever created becomes the active admin, so you
-- can bootstrap the system from the Supabase dashboard.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_username text;
  v_first boolean;
begin
  v_username := lower(coalesce(
    nullif(new.raw_user_meta_data->>'username', ''),
    split_part(new.email, '@', 1)
  ));
  v_username := regexp_replace(v_username, '[^a-z0-9._-]', '', 'g');
  if length(v_username) < 2 then v_username := 'user' || substr(new.id::text, 1, 8); end if;
  -- Avoid a clash with an existing username.
  if exists (select 1 from public.profiles where username = v_username) then
    v_username := left(v_username, 31) || '-' || substr(new.id::text, 1, 8);
  end if;

  v_first := not exists (select 1 from public.profiles);

  insert into public.profiles (id, username, full_name, role, active)
  values (
    new.id,
    v_username,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), case when v_first then 'OCC Administrator' else v_username end),
    case when v_first then 'admin' else 'shift_user' end,
    v_first
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- Stamp "entered by" from the logged-in account; never trust the client.
-- (When auth.uid() is NULL the change came from the SQL editor / service
-- role, and the values supplied are kept as-is.)
-- ---------------------------------------------------------------------
create or replace function public.stamp_delay_record()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.entered_by_user_id := auth.uid();
      new.entered_by := public.my_full_name();
    end if;
    new.created_at := now();
    new.updated_at := now();
  else
    new.entered_by_user_id := old.entered_by_user_id;
    new.entered_by := old.entered_by;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_stamp_delay_record on public.delay_records;
create trigger trg_stamp_delay_record
  before insert or update on public.delay_records
  for each row execute function public.stamp_delay_record();

create or replace function public.stamp_daily_figure()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is not null then new.entered_by := public.my_full_name(); end if;
  if tg_op = 'INSERT' then new.created_at := now(); else new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_stamp_defects on public.aircraft_defects;
create trigger trg_stamp_defects before insert or update on public.aircraft_defects
  for each row execute function public.stamp_daily_figure();
drop trigger if exists trg_stamp_flight_counts on public.flight_counts;
create trigger trg_stamp_flight_counts before insert or update on public.flight_counts
  for each row execute function public.stamp_daily_figure();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.aocs enable row level security;
alter table public.categories enable row level security;
alter table public.delay_reason_tags enable row level security;
alter table public.profiles enable row level security;
alter table public.delay_records enable row level security;
alter table public.delay_breakdown_items enable row level security;
alter table public.aircraft_defects enable row level security;
alter table public.flight_counts enable row level security;

-- Reference lists: readable by active users.
drop policy if exists aocs_read on public.aocs;
create policy aocs_read on public.aocs for select to authenticated using (public.is_active_user());
drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories for select to authenticated using (public.is_active_user());
drop policy if exists tags_read on public.delay_reason_tags;
create policy tags_read on public.delay_reason_tags for select to authenticated using (public.is_active_user());

-- Profiles: you can see your own; admins see everyone. Nobody can write
-- profiles from the browser - changes go through the admin-users function.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.my_role() = 'admin');

-- Delay records.
drop policy if exists records_read on public.delay_records;
create policy records_read on public.delay_records for select to authenticated
  using (public.is_active_user());
drop policy if exists records_insert on public.delay_records;
create policy records_insert on public.delay_records for insert to authenticated
  with check (public.is_active_user());
drop policy if exists records_update on public.delay_records;
create policy records_update on public.delay_records for update to authenticated
  using (
    public.my_role() in ('duty_manager','admin')
    or (public.my_role() = 'shift_user' and entered_by_user_id = auth.uid())
  )
  with check (public.is_active_user());
drop policy if exists records_delete on public.delay_records;
create policy records_delete on public.delay_records for delete to authenticated
  using (public.my_role() in ('duty_manager','admin'));

-- Breakdown lines follow their parent record's edit rule.
drop policy if exists breakdown_read on public.delay_breakdown_items;
create policy breakdown_read on public.delay_breakdown_items for select to authenticated
  using (public.is_active_user());
drop policy if exists breakdown_insert on public.delay_breakdown_items;
create policy breakdown_insert on public.delay_breakdown_items for insert to authenticated
  with check (public.can_edit_record(delay_record_id));
drop policy if exists breakdown_update on public.delay_breakdown_items;
create policy breakdown_update on public.delay_breakdown_items for update to authenticated
  using (public.can_edit_record(delay_record_id)) with check (public.can_edit_record(delay_record_id));
drop policy if exists breakdown_delete on public.delay_breakdown_items;
create policy breakdown_delete on public.delay_breakdown_items for delete to authenticated
  using (public.can_edit_record(delay_record_id));

-- Daily defects / flight counts: any active user can read and enter.
drop policy if exists defects_read on public.aircraft_defects;
create policy defects_read on public.aircraft_defects for select to authenticated using (public.is_active_user());
drop policy if exists defects_insert on public.aircraft_defects;
create policy defects_insert on public.aircraft_defects for insert to authenticated with check (public.is_active_user());
drop policy if exists defects_update on public.aircraft_defects;
create policy defects_update on public.aircraft_defects for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());

drop policy if exists fc_read on public.flight_counts;
create policy fc_read on public.flight_counts for select to authenticated using (public.is_active_user());
drop policy if exists fc_insert on public.flight_counts;
create policy fc_insert on public.flight_counts for insert to authenticated with check (public.is_active_user());
drop policy if exists fc_update on public.flight_counts;
create policy fc_update on public.flight_counts for update to authenticated
  using (public.is_active_user()) with check (public.is_active_user());

-- ---------------------------------------------------------------------
-- Save a delay record + its breakdown in one transaction. Mirrors the old
-- POST /api/records and PUT /api/records/:id exactly. Runs with the
-- caller's own permissions (SECURITY INVOKER), so the rules above apply.
-- ---------------------------------------------------------------------
create or replace function public.save_delay_record(p_id bigint, p jsonb)
returns bigint language plpgsql security invoker set search_path = ''
as $$
declare
  v_existing public.delay_records;
  v_id bigint;
  v_breakdown jsonb;
  v_breakdown_provided boolean;
  v_total integer;
  v_minutes integer;
  v_item jsonb;
  v_i integer := 0;
  v_record_date text;
  v_aoc text;
  v_category text;
  v_reason text;
  v_dm text;
begin
  if not public.is_active_user() then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Invalid request body';
  end if;

  if p_id is not null then
    select * into v_existing from public.delay_records where id = p_id;
    if not found then raise exception 'Not found'; end if;
    if not public.can_edit_record(p_id) then
      raise exception 'Only the original author or a duty manager can edit this record' using errcode = '42501';
    end if;
  end if;

  -- Merge with the existing row for updates (same as { ...existing, ...body }).
  v_record_date := coalesce(case when p ? 'record_date' then p->>'record_date' end, v_existing.record_date::text);
  v_aoc         := coalesce(case when p ? 'aoc' then p->>'aoc' end, v_existing.aoc);
  v_category    := coalesce(case when p ? 'category' then p->>'category' end, v_existing.category);
  v_reason      := coalesce(case when p ? 'reason' then p->>'reason' end, v_existing.reason);

  if coalesce(btrim(v_record_date), '') = '' then raise exception 'record_date is required'; end if;
  if coalesce(btrim(v_aoc), '') = '' then raise exception 'aoc is required'; end if;
  if coalesce(btrim(v_category), '') = '' then raise exception 'category is required'; end if;
  if coalesce(btrim(v_reason), '') = '' then raise exception 'reason is required'; end if;
  if v_record_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'record_date must be YYYY-MM-DD'; end if;
  if not exists (select 1 from public.aocs where code = v_aoc) then raise exception 'Unknown AOC code'; end if;
  if not exists (select 1 from public.categories where code = v_category) then raise exception 'Unknown category code'; end if;

  v_dm := case when p ? 'delay_minutes' then nullif(btrim(coalesce(p->>'delay_minutes', '')), '')
               else v_existing.delay_minutes::text end;
  if v_dm is not null and v_dm !~ '^\d+(\.\d+)?$' then
    raise exception 'delay_minutes must be a non-negative number';
  end if;

  v_breakdown_provided := p ? 'breakdown';
  v_breakdown := case when v_breakdown_provided and jsonb_typeof(p->'breakdown') = 'array' then p->'breakdown' else '[]'::jsonb end;

  for v_item in select * from jsonb_array_elements(v_breakdown) loop
    if coalesce(v_item->>'reason_tag', '') <> ''
       and not exists (select 1 from public.delay_reason_tags where code = v_item->>'reason_tag') then
      raise exception 'Unknown delay reason tag in breakdown';
    end if;
    if v_item ? 'minutes' and coalesce(v_item->>'minutes', '') <> '' and (v_item->>'minutes') !~ '^\d+(\.\d+)?$' then
      raise exception 'Breakdown minutes must be a non-negative number';
    end if;
  end loop;

  -- Total delay = sum of breakdown minutes when a breakdown is present.
  if v_breakdown_provided then
    select sum(round(coalesce(nullif(e->>'minutes', '')::numeric, 0)))::integer into v_total
      from jsonb_array_elements(v_breakdown) e
      where coalesce(e->>'minutes', '') ~ '^\d+(\.\d+)?$';
  elsif p_id is not null then
    select sum(minutes)::integer into v_total from public.delay_breakdown_items where delay_record_id = p_id;
  end if;
  if v_total is not null and v_total <= 0 then v_total := null; end if;
  v_minutes := coalesce(v_total, round(v_dm::numeric)::integer);

  if p_id is null then
    insert into public.delay_records
      (record_date, shift, aoc, category, flight_number, route, registration, reason,
       delay_minutes, downstream_impact, status, batch_id, flights_free_text)
    values (
      v_record_date::date, '', v_aoc, v_category,
      nullif(p->>'flight_number', ''), nullif(p->>'route', ''), nullif(p->>'registration', ''),
      btrim(v_reason), v_minutes, nullif(p->>'downstream_impact', ''), 'closed',
      left(nullif(btrim(coalesce(p->>'batch_id', '')), ''), 100),
      case when btrim(coalesce(p->>'flights_free_text', '')) <> '' then p->>'flights_free_text' end
    )
    returning id into v_id;
  else
    v_id := p_id;
    update public.delay_records set
      record_date = v_record_date::date,
      aoc = v_aoc,
      category = v_category,
      flight_number = case when p ? 'flight_number' then nullif(p->>'flight_number', '') else v_existing.flight_number end,
      route = case when p ? 'route' then nullif(p->>'route', '') else v_existing.route end,
      registration = case when p ? 'registration' then nullif(p->>'registration', '') else v_existing.registration end,
      reason = btrim(v_reason),
      reason_clean = null,
      delay_minutes = v_minutes,
      downstream_impact = case when p ? 'downstream_impact' then nullif(p->>'downstream_impact', '') else v_existing.downstream_impact end
    where id = v_id;
  end if;

  -- Replace breakdown lines (skipping rows without a tag or minutes, as before).
  if v_breakdown_provided or p_id is null then
    delete from public.delay_breakdown_items where delay_record_id = v_id;
    for v_item in select * from jsonb_array_elements(v_breakdown) loop
      if coalesce(v_item->>'reason_tag', '') <> ''
         and coalesce(v_item->>'minutes', '') ~ '^\d+(\.\d+)?$'
         and (v_item->>'minutes')::numeric > 0 then
        insert into public.delay_breakdown_items (delay_record_id, reason_tag, minutes, note, sort_order)
        values (v_id, v_item->>'reason_tag', round((v_item->>'minutes')::numeric)::integer,
                nullif(v_item->>'note', ''), v_i);
      end if;
      v_i := v_i + 1;
    end loop;
  end if;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions: anonymous visitors get nothing; logged-in users get only
-- what the policies above allow.
-- ---------------------------------------------------------------------
revoke all on public.aocs, public.categories, public.delay_reason_tags, public.profiles,
  public.delay_records, public.delay_breakdown_items, public.aircraft_defects, public.flight_counts
  from anon, authenticated, public;

grant select on public.aocs, public.categories, public.delay_reason_tags, public.profiles to authenticated;
grant select, insert, update, delete on public.delay_records, public.delay_breakdown_items to authenticated;
grant select, insert, update on public.aircraft_defects, public.flight_counts to authenticated;

revoke execute on function public.my_role(), public.is_active_user(), public.my_full_name(),
  public.can_edit_record(bigint), public.save_delay_record(bigint, jsonb),
  public.handle_new_auth_user(), public.stamp_delay_record(), public.stamp_daily_figure()
  from anon, public;
grant execute on function public.my_role(), public.is_active_user(), public.my_full_name(),
  public.can_edit_record(bigint), public.save_delay_record(bigint, jsonb) to authenticated;
