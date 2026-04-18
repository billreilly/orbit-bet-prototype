create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  balance numeric(12,2) not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_rounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  game text not null,
  detail text not null,
  delta numeric(12,2) not null,
  balance_after numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute procedure public.update_updated_at_column();

alter table public.profiles enable row level security;
alter table public.game_rounds enable row level security;

create policy "users can read own profile"
on public.profiles for select
using (auth.uid() = id);

create policy "users can update own profile"
on public.profiles for update
using (auth.uid() = id);

create policy "users can insert own rounds"
on public.game_rounds for insert
with check (auth.uid() = user_id);

create policy "users can read own rounds"
on public.game_rounds for select
using (auth.uid() = user_id);
