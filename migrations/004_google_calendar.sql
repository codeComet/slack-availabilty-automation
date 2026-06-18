-- Migration: 004_google_calendar
-- Adds Google Calendar integration support.
-- google_connections stores per-user OAuth tokens (refresh token) keyed by company email.
-- availability_logs gains a column to store the Google Calendar event ID created for 'leave'.

-- Table: one row per user who has connected their Google account
create table public.google_connections (
  id              uuid        primary key default gen_random_uuid(),
  user_email      text        not null unique,     -- company email — same key used across workspaces
  access_token    text,                            -- short-lived; refreshed automatically
  refresh_token   text        not null,            -- long-lived; used to obtain new access tokens
  token_expiry    timestamptz,                     -- when the current access_token expires
  connected_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index google_connections_email_idx on public.google_connections(user_email);

-- Trigger: keep updated_at current on every row update
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger google_connections_updated_at
  before update on public.google_connections
  for each row execute procedure public.set_updated_at();

-- Add Google Calendar event ID to availability_logs so /availability clear can delete it
alter table public.availability_logs
  add column if not exists google_calendar_event_id text default null;
