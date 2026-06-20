-- Field Verification Log — Supabase Phase 1 schema, security, and photo storage.
-- Paste this whole file into the Supabase SQL Editor (Project -> SQL Editor -> New query) and Run.
-- It is safe to run more than once.

-- 1) server-clock timestamp trigger (the server decides version time, not the phone)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

-- 2) assets table (all variable per-asset content lives in JSONB so the form can grow with no migrations)
create table if not exists public.assets (
  id          uuid primary key,
  owner_id    uuid not null default auth.uid(),
  asset_type  text,
  title       text,
  data        jsonb default '{}'::jsonb,
  world_value jsonb default '{}'::jsonb,
  photo_count int  default 0,
  is_deleted  boolean default false,
  version     int  default 1,
  device_id   text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
drop trigger if exists trg_assets_updated on public.assets;
create trigger trg_assets_updated before insert or update on public.assets
  for each row execute function public.set_updated_at();

-- 3) photos table (the image bytes live in Storage; this row is the metadata + checksum)
create table if not exists public.photos (
  id          uuid primary key,
  asset_id    uuid,
  owner_id    uuid not null default auth.uid(),
  section_id  text,
  storage_path text,
  mime        text,
  byte_size   int,
  width       int,
  height      int,
  caption     text,
  sha256      text,
  is_deleted  boolean default false,
  version     int default 1,
  device_id   text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
drop trigger if exists trg_photos_updated on public.photos;
create trigger trg_photos_updated before insert or update on public.photos
  for each row execute function public.set_updated_at();

create index if not exists photos_asset_idx on public.photos(asset_id);
create index if not exists assets_owner_updated_idx on public.assets(owner_id, updated_at);
create index if not exists photos_owner_updated_idx on public.photos(owner_id, updated_at);

-- 4) Row-Level Security: a logged-in user can only ever touch their own rows.
alter table public.assets enable row level security;
alter table public.photos enable row level security;

drop policy if exists assets_own on public.assets;
create policy assets_own on public.assets
  for all to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists photos_own on public.photos;
create policy photos_own on public.photos
  for all to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- 5) private photo storage bucket + per-user folder policies (path = <owner_id>/<asset_id>/<photo_id>.jpg)
insert into storage.buckets (id, name, public)
values ('asset-photos', 'asset-photos', false)
on conflict (id) do nothing;

drop policy if exists photos_obj_read on storage.objects;
create policy photos_obj_read on storage.objects
  for select to authenticated
  using (bucket_id = 'asset-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_obj_write on storage.objects;
create policy photos_obj_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'asset-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_obj_update on storage.objects;
create policy photos_obj_update on storage.objects
  for update to authenticated
  using (bucket_id = 'asset-photos' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists photos_obj_delete on storage.objects;
create policy photos_obj_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'asset-photos' and (storage.foldername(name))[1] = auth.uid()::text);
