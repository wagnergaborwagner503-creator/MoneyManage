-- ============ MoneyManage (MM) – Supabase adatbázis séma ============
-- Futtasd le ezt a teljes fájlt a Supabase Dashboard → SQL Editor-ban
-- (New query → paste → Run). Ha már lefuttatod egyszer és újra futtatod,
-- a DROP IF EXISTS / CREATE OR REPLACE gondoskodik arról, hogy ne legyen hiba.

-- ==========================================================================
-- TÁBLÁK
-- ==========================================================================

-- ---------- Profilok ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text,
  created_at timestamptz default now()
);

-- Új felhasználó regisztrációjakor automatikusan létrejön a profil
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- Kategóriák ----------
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  icon       text default '📦',
  color      text default '#64748b',
  budget     numeric default 0,
  sort       integer default 0,
  created_at timestamptz default now()
);

-- ---------- Tranzakciók ----------
create table if not exists public.transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  type         text not null check (type in ('expense', 'income', 'saving')),
  amount       numeric not null check (amount > 0),
  category_id  uuid references public.categories(id) on delete set null,
  goal_id      uuid,
  note         text,
  date         date not null default current_date,
  recurring_id uuid,
  pending      boolean default false,   -- true = jövőbeli/tervezett tétel (statisztikába még nem, hó végi egyenlegbe igen)
  from_savings boolean default false,   -- true = cél megvalósításakor a megtakarításból felhasznált összeg (income, de külön kezelve)
  created_at   timestamptz default now()
);

create index if not exists idx_transactions_user_date on public.transactions(user_id, date);

-- ---------- Célok ----------
create table if not exists public.goals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  icon          text default '🎯',
  target_amount numeric not null check (target_amount > 0),
  start_amount  numeric default 0,
  deadline      date,
  done          boolean default false,
  created_at    timestamptz default now()
);

-- ---------- Ismétlődő tételek ----------
create table if not exists public.recurring (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  name           text not null,
  amount         numeric not null check (amount > 0),
  type           text not null check (type in ('expense', 'income')),
  category_id    uuid references public.categories(id) on delete set null,
  day            integer default 1 check (day between 1 and 31),  -- régi mező (visszafelé kompatibilitás)
  interval_unit  text default 'month' check (interval_unit in ('day', 'week', 'month', 'year')),
  interval_count integer default 1 check (interval_count >= 1),
  anchor_date    date,        -- első előfordulás dátuma (innen számoljuk az ismétlődést)
  active         boolean default true,
  created_at     timestamptz default now()
);

-- ---------- Meglévő adatbázis frissítése (ha már korábban lefuttattad a sémát) ----------
-- Ezek hozzáadják az új oszlopokat, ha még hiányoznak. Hibamentes, ha már léteznek.
alter table public.transactions add column if not exists pending boolean default false;
alter table public.transactions add column if not exists from_savings boolean default false;
alter table public.recurring    add column if not exists interval_unit  text    default 'month';
alter table public.recurring    add column if not exists interval_count integer default 1;
alter table public.recurring    add column if not exists anchor_date    date;

-- ---------- Visszajelzések / tippek ----------
-- Ide kerülnek az alkalmazásból küldött visszajelzések.
-- A Supabase Dashboard → Table Editor → feedback táblában látod az összes beküldött üzenetet.
-- A felhasználók csak a saját bejegyzéseiket látják, de a dashboard service_role-lal mindent mutat.
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete set null,  -- null = névtelen (helyi mód)
  email      text,          -- a beküldő e-mail címe (tájékoztató, nem kötelező)
  category   text not null check (category in ('bug', 'tip', 'feature', 'other')) default 'other',
  message    text not null,
  app_version text default '1.0',
  created_at timestamptz default now()
);

create index if not exists idx_feedback_created on public.feedback(created_at desc);

-- ==========================================================================
-- ROW LEVEL SECURITY – minden tábla külön politikával, minden műveletre
-- ==========================================================================

alter table public.profiles    enable row level security;
alter table public.categories  enable row level security;
alter table public.transactions enable row level security;
alter table public.goals       enable row level security;
alter table public.recurring   enable row level security;
alter table public.feedback    enable row level security;

-- FORCE RLS: a szabályok a tábla tulajdonosára is vonatkoznak (defense-in-depth).
-- Így minden felhasználó KIZÁRÓLAG a saját adatát éri el; senki nem látja másét.
alter table public.profiles    force row level security;
alter table public.categories  force row level security;
alter table public.transactions force row level security;
alter table public.goals       force row level security;
alter table public.recurring   force row level security;
alter table public.feedback    force row level security;

-- ---- PROFILES ----
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using (auth.uid() = id);

-- ---- CATEGORIES ----
drop policy if exists "categories_select" on public.categories;
create policy "categories_select" on public.categories
  for select using (auth.uid() = user_id);

drop policy if exists "categories_insert" on public.categories;
create policy "categories_insert" on public.categories
  for insert with check (auth.uid() = user_id);

drop policy if exists "categories_update" on public.categories;
create policy "categories_update" on public.categories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "categories_delete" on public.categories;
create policy "categories_delete" on public.categories
  for delete using (auth.uid() = user_id);

-- ---- TRANSACTIONS ----
drop policy if exists "transactions_select" on public.transactions;
create policy "transactions_select" on public.transactions
  for select using (auth.uid() = user_id);

drop policy if exists "transactions_insert" on public.transactions;
create policy "transactions_insert" on public.transactions
  for insert with check (auth.uid() = user_id);

drop policy if exists "transactions_update" on public.transactions;
create policy "transactions_update" on public.transactions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "transactions_delete" on public.transactions;
create policy "transactions_delete" on public.transactions
  for delete using (auth.uid() = user_id);

-- ---- GOALS ----
drop policy if exists "goals_select" on public.goals;
create policy "goals_select" on public.goals
  for select using (auth.uid() = user_id);

drop policy if exists "goals_insert" on public.goals;
create policy "goals_insert" on public.goals
  for insert with check (auth.uid() = user_id);

drop policy if exists "goals_update" on public.goals;
create policy "goals_update" on public.goals
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "goals_delete" on public.goals;
create policy "goals_delete" on public.goals
  for delete using (auth.uid() = user_id);

-- ---- RECURRING ----
drop policy if exists "recurring_select" on public.recurring;
create policy "recurring_select" on public.recurring
  for select using (auth.uid() = user_id);

drop policy if exists "recurring_insert" on public.recurring;
create policy "recurring_insert" on public.recurring
  for insert with check (auth.uid() = user_id);

drop policy if exists "recurring_update" on public.recurring;
create policy "recurring_update" on public.recurring
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "recurring_delete" on public.recurring;
create policy "recurring_delete" on public.recurring
  for delete using (auth.uid() = user_id);

-- ---- FEEDBACK ----
-- Beküldeni bárki tud (bejelentkezett felhasználó). Saját bejegyzéseit látja.
-- Te (fejlesztő) a Supabase Dashboard Table Editor-ban MINDET látod (service_role megkerüli az RLS-t).

drop policy if exists "feedback_select" on public.feedback;
create policy "feedback_select" on public.feedback
  for select using (auth.uid() = user_id);

drop policy if exists "feedback_insert" on public.feedback;
create policy "feedback_insert" on public.feedback
  for insert with check (
    auth.uid() = user_id       -- bejelentkezett: a saját user_id-jára küld
    or user_id is null         -- helyi mód: user_id lehet null
  );

drop policy if exists "feedback_delete" on public.feedback;
create policy "feedback_delete" on public.feedback
  for delete using (auth.uid() = user_id);

-- ==========================================================================
-- MEGJEGYZÉS A FEJLESZTŐNEK – Visszajelzések megtekintése Supabase-ben
-- ==========================================================================
-- 1. Supabase Dashboard → bal menü: Table Editor → válaszd a "feedback" táblát
-- 2. Látsz minden beküldött visszajelzést: dátum, kategória, üzenet, user_id, e-mail
-- 3. Szűrhetsz (category = 'bug' stb.), rendezhetsz dátum szerint
-- 4. Exportálhatod CSV-be: jobb felső sarok → Download as CSV
-- 5. (Opcionális) SQL Editor-ban is lekérdezheted:
--    SELECT created_at, category, message, email FROM feedback ORDER BY created_at DESC;
-- ==========================================================================
