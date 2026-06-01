-- BracketLab Supabase setup. Run once in the Supabase SQL editor.
-- Stack: static index.html (GitHub Pages) + Supabase (Postgres + Storage).
-- No user auth: clients use the public anon key; access is governed by the
-- Row Level Security policies below.

-- gen_random_uuid() ships with Supabase; this is a no-op safety net.
create extension if not exists pgcrypto;

-- ============================ TABLES ============================
create table if not exists public.sets (
  code        text primary key,                       -- 5-char base36 share code
  question    text,
  entries     jsonb not null default '[]'::jsonb,      -- [{ name, img }]  img = public URL or null
  created_at  timestamptz not null default now(),
  created_by  text default ''
);

create table if not exists public.picks (
  pick_id     uuid primary key default gen_random_uuid(),
  code        text not null references public.sets(code) on delete cascade,
  player_id   text not null,                           -- localStorage PLAYER_ID
  bracket     jsonb,                                   -- serialized cols
  ranking     jsonb not null default '[]'::jsonb,      -- winner -> last (name strings)
  score       jsonb not null default '{}'::jsonb,      -- name -> score
  created_at  timestamptz not null default now(),
  unique (code, player_id)                             -- one pick per player per bracket
);

create index if not exists picks_code_idx on public.picks (code);

-- ===================== ROW LEVEL SECURITY =======================
-- anon = the public key shipped in the static HTML. We allow public read and
-- insert, but NO update/delete, so existing rows can't be tampered with.
alter table public.sets  enable row level security;
alter table public.picks enable row level security;

create policy "sets_anon_select"  on public.sets  for select to anon using (true);
create policy "sets_anon_insert"  on public.sets  for insert to anon with check (true);
create policy "picks_anon_select" on public.picks for select to anon using (true);
create policy "picks_anon_insert" on public.picks for insert to anon with check (true);

-- ========================= STORAGE ==============================
-- Public bucket, image-only, 5 MB cap (limits abuse/cost for a no-auth app).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('entry-images', 'entry-images', true, 5242880,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update
  set public             = true,
      file_size_limit    = 5242880,
      allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif'];

create policy "entry_images_anon_insert" on storage.objects
  for insert to anon with check (bucket_id = 'entry-images');

create policy "entry_images_public_select" on storage.objects
  for select to anon using (bucket_id = 'entry-images');
