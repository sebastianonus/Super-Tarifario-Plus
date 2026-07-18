-- Super Tarifario PLUS - esquema inicial Supabase
-- Ejecutar en Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  contact_email text,
  billing_email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  is_active boolean not null default true
);

create table if not exists public.access_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login_code text not null unique,
  pin text not null,
  role text not null default 'client' check (role in ('admin', 'client')),
  client_id uuid references public.clients(id) on delete set null,
  can_view_all_tariffs boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz,
  is_active boolean not null default true
);

create table if not exists public.tariffs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  source_file text,
  version text,
  engine_key text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_active boolean not null default true
);

create table if not exists public.client_tariffs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  tariff_id uuid not null references public.tariffs(id) on delete cascade,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (client_id, tariff_id)
);

create table if not exists public.analyses (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete set null,
  tariff_id uuid references public.tariffs(id) on delete set null,
  created_by uuid references public.access_users(id) on delete set null,
  input_text text,
  input_files jsonb not null default '[]'::jsonb,
  summary text,
  pricing_request jsonb not null default '{}'::jsonb,
  missing_data jsonb not null default '[]'::jsonb,
  detected_criteria jsonb not null default '[]'::jsonb,
  ai_model text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'priced', 'failed')),
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid references public.analyses(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  tariff_id uuid references public.tariffs(id) on delete set null,
  created_by uuid references public.access_users(id) on delete set null,
  document_type text not null default 'proposal' check (document_type in ('budget', 'proposal')),
  pricing_result jsonb not null default '{}'::jsonb,
  lines jsonb not null default '[]'::jsonb,
  base_amount numeric(12, 2),
  vat_percentage numeric(5, 2) not null default 21,
  vat_amount numeric(12, 2),
  total_amount numeric(12, 2),
  currency text not null default 'EUR',
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_messages (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  recipient_email text,
  subject text,
  body text,
  provider text not null default 'local',
  provider_message_id text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table if not exists public.quote_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  actor_id uuid references public.access_users(id) on delete set null,
  event_type text not null check (event_type in ('created', 'edited', 'calculated', 'sent', 'accepted', 'rejected', 'expired')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.analysis_files (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references public.analyses(id) on delete cascade,
  file_name text not null,
  mime_type text,
  storage_path text,
  extracted_text text,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists access_users_set_updated_at on public.access_users;
create trigger access_users_set_updated_at
before update on public.access_users
for each row execute function public.set_updated_at();

drop trigger if exists tariffs_set_updated_at on public.tariffs;
create trigger tariffs_set_updated_at
before update on public.tariffs
for each row execute function public.set_updated_at();

drop trigger if exists quotes_set_updated_at on public.quotes;
create trigger quotes_set_updated_at
before update on public.quotes
for each row execute function public.set_updated_at();

alter table public.clients enable row level security;
alter table public.access_users enable row level security;
alter table public.tariffs enable row level security;
alter table public.client_tariffs enable row level security;
alter table public.analyses enable row level security;
alter table public.quotes enable row level security;
alter table public.quote_messages enable row level security;
alter table public.quote_events enable row level security;
alter table public.analysis_files enable row level security;

-- En esta fase el backend usa service_role, que salta RLS.
-- No se crean policies publicas para evitar exponer PINs desde el navegador.

insert into public.clients (name, code, is_active)
values
  ('Onus Express', 'onus', true),
  ('Meteor', 'meteor', true),
  ('Districenter', 'districenter', true)
on conflict (code) do update
set name = excluded.name,
    is_active = excluded.is_active;

insert into public.tariffs (code, name, description, source_file, version, engine_key, is_active)
values
  ('onus-express-julio27', 'Onus Express 2026', 'Tarifario Onus Express 2026 cargado desde VS Code.', 'HOJA DE TARIFARIO COMPLETA _Julio27.xlsx', '2026', 'onus', true),
  ('meteor', 'Meteor', 'Tarifario Meteor cargado desde VS Code. Fuente: Tarifas meteor.jpeg', 'Tarifas meteor.jpeg', '2026', 'meteor', true),
  ('districenter', 'Districenter', 'Tarifario Districenter cargado desde VS Code. Fuente: Tarifario_Districenter.docx', 'Tarifario_Districenter.docx', '2026', 'districenter', true)
on conflict (code) do update
set name = excluded.name,
    description = excluded.description,
    source_file = excluded.source_file,
    version = excluded.version,
    engine_key = excluded.engine_key,
    is_active = excluded.is_active;

insert into public.access_users (name, login_code, pin, role, client_id, can_view_all_tariffs, is_active)
select 'Onus Express', 'onus', '7257', 'admin', c.id, true, true
from public.clients c
where c.code = 'onus'
on conflict (login_code) do update
set name = excluded.name,
    pin = excluded.pin,
    role = excluded.role,
    client_id = excluded.client_id,
    can_view_all_tariffs = excluded.can_view_all_tariffs,
    is_active = excluded.is_active;

insert into public.access_users (name, login_code, pin, role, client_id, can_view_all_tariffs, is_active)
select 'Meteor', 'meteor', 'meteor2026', 'client', c.id, false, true
from public.clients c
where c.code = 'meteor'
on conflict (login_code) do update
set name = excluded.name,
    pin = excluded.pin,
    role = excluded.role,
    client_id = excluded.client_id,
    can_view_all_tariffs = excluded.can_view_all_tariffs,
    is_active = excluded.is_active;

insert into public.access_users (name, login_code, pin, role, client_id, can_view_all_tariffs, is_active)
select 'Districenter', 'districenter', 'districenter2026', 'client', c.id, false, true
from public.clients c
where c.code = 'districenter'
on conflict (login_code) do update
set name = excluded.name,
    pin = excluded.pin,
    role = excluded.role,
    client_id = excluded.client_id,
    can_view_all_tariffs = excluded.can_view_all_tariffs,
    is_active = excluded.is_active;

insert into public.client_tariffs (client_id, tariff_id, is_default)
select c.id, t.id, true
from public.clients c
join public.tariffs t on t.code = 'meteor'
where c.code = 'meteor'
on conflict (client_id, tariff_id) do update
set is_default = excluded.is_default;

insert into public.client_tariffs (client_id, tariff_id, is_default)
select c.id, t.id, true
from public.clients c
join public.tariffs t on t.code = 'districenter'
where c.code = 'districenter'
on conflict (client_id, tariff_id) do update
set is_default = excluded.is_default;

insert into public.client_tariffs (client_id, tariff_id, is_default)
select c.id, t.id, t.code = 'onus-express-julio27'
from public.clients c
cross join public.tariffs t
where c.code = 'onus'
on conflict (client_id, tariff_id) do update
set is_default = excluded.is_default;
