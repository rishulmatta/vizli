-- Run with the Supabase SQL editor or `supabase db push` against your own project.
-- A public browser key may access this table only through authenticated owner policies.
create table if not exists public.projects (
  id text not null check (char_length(id) between 1 and 120),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) <= 300),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.projects enable row level security;
revoke all on public.projects from anon;
grant select, insert, update, delete on public.projects to authenticated;

create policy "Owners can read their projects" on public.projects
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Owners can insert their projects" on public.projects
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Owners can update their projects" on public.projects
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Owners can delete their projects" on public.projects
  for delete to authenticated using ((select auth.uid()) = user_id);

create index if not exists projects_owner_updated_idx on public.projects(user_id, updated_at desc);
