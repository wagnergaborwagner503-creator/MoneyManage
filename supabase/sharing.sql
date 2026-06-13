-- ============================================================
-- MoneyManage – KÖZÖS FIÓK (párok / barátok) kiegészítő séma
-- Futtasd le a schema.sql UTÁN, a Supabase SQL Editorban.
-- Idempotens: bármikor újrafuttatható.
-- ============================================================

-- ---- Új oszlopok a megosztáshoz (közös tételek/keretek/célok egy háztartáshoz tartoznak) ----
alter table public.transactions add column if not exists household_id uuid;
alter table public.categories   add column if not exists household_id uuid;
alter table public.goals        add column if not exists household_id uuid;

-- ---- Háztartás (közös tér) ----
create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text default 'Közös kassza',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists public.household_members (
  household_id uuid references public.households(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz default now(),
  primary key (household_id, user_id)
);

create table if not exists public.invite_codes (
  code         text primary key,
  household_id uuid references public.households(id) on delete cascade,
  created_by   uuid references auth.users(id) on delete set null,
  expires_at   timestamptz,
  created_at   timestamptz default now()
);

-- Közös célok hozzájárulás-naplója: minden befizetés egy sor.
-- A cél összgyűjtött összege = start_amount + SUM(amount) (mindkét fél befizetése látszik),
-- de a befizető SAJÁT megtakarítása a privát 'transactions' saving tételből jön.
create table if not exists public.shared_contributions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  goal_id      uuid not null references public.goals(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text,
  amount       numeric not null check (amount > 0),
  date         date not null default current_date,
  created_at   timestamptz default now()
);

-- ---- Tagsági ellenőrző függvény (SECURITY DEFINER – elkerüli az RLS-rekurziót) ----
create or replace function public.is_household_member(hid uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.household_members where household_id = hid and user_id = auth.uid());
$$;

-- ==========================================================================
-- RPC függvények (a kód-alapú összecsatoláshoz; SECURITY DEFINER)
-- ==========================================================================

-- Meghívó kód generálása (ha még nincs háztartása a hívónak, létrehoz egyet)
create or replace function public.mm_create_invite()
returns text language plpgsql security definer set search_path = public as $$
declare hid uuid; c text; tries int := 0;
begin
  select household_id into hid from public.household_members where user_id = auth.uid() limit 1;
  if hid is null then
    insert into public.households(name, created_by) values ('Közös kassza', auth.uid()) returning id into hid;
    insert into public.household_members(household_id, user_id, display_name)
      values (hid, auth.uid(), coalesce((select name from public.profiles where id = auth.uid()), ''));
  end if;
  loop
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into public.invite_codes(code, household_id, created_by, expires_at)
        values (c, hid, auth.uid(), now() + interval '7 days');
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 25 then raise exception 'CODE_GEN_FAILED'; end if;
    end;
  end loop;
  return c;
end; $$;

-- Csatlakozás meghívó kóddal
create or replace function public.mm_join(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare hid uuid;
begin
  select household_id into hid from public.invite_codes
    where code = p_code and (expires_at is null or expires_at > now());
  if hid is null then raise exception 'INVALID_CODE'; end if;
  insert into public.household_members(household_id, user_id, display_name)
    values (hid, auth.uid(), coalesce((select name from public.profiles where id = auth.uid()), ''))
    on conflict (household_id, user_id) do nothing;
  return hid;
end; $$;

-- Kilépés a közös térből
create or replace function public.mm_leave(p_hid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.household_members where household_id = p_hid and user_id = auth.uid();
end; $$;

grant execute on function public.mm_create_invite() to authenticated;
grant execute on function public.mm_join(text) to authenticated;
grant execute on function public.mm_leave(uuid) to authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;

-- ==========================================================================
-- ROW LEVEL SECURITY a közös táblákon
-- ==========================================================================
alter table public.households          enable row level security;
alter table public.household_members   enable row level security;
alter table public.invite_codes        enable row level security;
alter table public.shared_contributions enable row level security;
alter table public.households          force row level security;
alter table public.household_members   force row level security;
alter table public.invite_codes        force row level security;
alter table public.shared_contributions force row level security;

-- households: csak a tagok látják
drop policy if exists "households_select" on public.households;
create policy "households_select" on public.households
  for select using (public.is_household_member(id));

-- household_members: a tag látja a saját háztartása tagjait
drop policy if exists "members_select" on public.household_members;
create policy "members_select" on public.household_members
  for select using (public.is_household_member(household_id));
-- (beszúrás/törlés csak az RPC-ken keresztül történik – azok megkerülik az RLS-t)

-- invite_codes: NINCS kliens-oldali hozzáférés (csak az RPC olvassa/írja) → a kódok priváttak

-- shared_contributions: a tagok látják; beírni a saját nevében lehet
drop policy if exists "contrib_select" on public.shared_contributions;
create policy "contrib_select" on public.shared_contributions
  for select using (public.is_household_member(household_id));
drop policy if exists "contrib_insert" on public.shared_contributions;
create policy "contrib_insert" on public.shared_contributions
  for insert with check (auth.uid() = user_id and public.is_household_member(household_id));
drop policy if exists "contrib_delete" on public.shared_contributions;
create policy "contrib_delete" on public.shared_contributions
  for delete using (auth.uid() = user_id);

-- ==========================================================================
-- A meglévő táblák szabályainak FRISSÍTÉSE: a saját adat PRIVÁT marad,
-- a közös (household_id-vel ellátott) tételeket a háztartás tagjai látják/kezelik.
-- ==========================================================================

-- TRANSACTIONS
drop policy if exists "transactions_select" on public.transactions;
create policy "transactions_select" on public.transactions
  for select using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));
drop policy if exists "transactions_insert" on public.transactions;
create policy "transactions_insert" on public.transactions
  for insert with check (auth.uid() = user_id and (household_id is null or public.is_household_member(household_id)));
drop policy if exists "transactions_update" on public.transactions;
create policy "transactions_update" on public.transactions
  for update using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));
drop policy if exists "transactions_delete" on public.transactions;
create policy "transactions_delete" on public.transactions
  for delete using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));

-- CATEGORIES
drop policy if exists "categories_select" on public.categories;
create policy "categories_select" on public.categories
  for select using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));
drop policy if exists "categories_insert" on public.categories;
create policy "categories_insert" on public.categories
  for insert with check (auth.uid() = user_id and (household_id is null or public.is_household_member(household_id)));
drop policy if exists "categories_update" on public.categories;
create policy "categories_update" on public.categories
  for update using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));
drop policy if exists "categories_delete" on public.categories;
create policy "categories_delete" on public.categories
  for delete using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));

-- GOALS
drop policy if exists "goals_select" on public.goals;
create policy "goals_select" on public.goals
  for select using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));
drop policy if exists "goals_insert" on public.goals;
create policy "goals_insert" on public.goals
  for insert with check (auth.uid() = user_id and (household_id is null or public.is_household_member(household_id)));
drop policy if exists "goals_update" on public.goals;
create policy "goals_update" on public.goals
  for update using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));
drop policy if exists "goals_delete" on public.goals;
create policy "goals_delete" on public.goals
  for delete using (auth.uid() = user_id or (household_id is not null and public.is_household_member(household_id)));

-- KÉSZ. A privát (household_id IS NULL) adatokat csak a tulajdonos látja;
-- a közös tételeket kizárólag a háztartás tagjai. Senki más.
