-- Client Dossier: database setup for Supabase
-- Run this ONCE in your Supabase project: SQL Editor -> New query -> paste -> Run.

create table if not exists public.clients (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),

  name         text not null,
  family_name  text not null default '',
  relation     text not null default '',        -- e.g. "Primary Contact", "Spouse", "Son"
  tags         text[] not null default '{}',    -- WhatsApp group name(s) used by the optional sync tool
  email        text not null default '',
  phone        text not null default '',
  address      text not null default '',
  birthday     date,
  anniversary  date,
  utc_offset   numeric,                         -- hours from you, e.g. 5.5 or -8
  personal_life text not null default '',

  notes        jsonb not null default '[]'::jsonb,        -- [{id,date,type,title,content}]
  meetings     jsonb not null default '[]'::jsonb,        -- [{id,date,title,notes}]
  transactions jsonb not null default '[]'::jsonb         -- [{id,date,amount,type,note}]
);

-- Row Level Security: only logged-in users can touch client data. Logged-out visitors get nothing.
alter table public.clients enable row level security;

drop policy if exists "Signed-in users can read clients"   on public.clients;
drop policy if exists "Signed-in users can add clients"    on public.clients;
drop policy if exists "Signed-in users can edit clients"   on public.clients;
drop policy if exists "Signed-in users can delete clients" on public.clients;

create policy "Signed-in users can read clients"   on public.clients for select to authenticated using (true);
create policy "Signed-in users can add clients"    on public.clients for insert to authenticated with check (true);
create policy "Signed-in users can edit clients"   on public.clients for update to authenticated using (true) with check (true);
create policy "Signed-in users can delete clients" on public.clients for delete to authenticated using (true);

-- Table privileges. Tables made through the SQL editor don't always get these automatically.
grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.clients to service_role;  -- needed by the optional WhatsApp sync tool
