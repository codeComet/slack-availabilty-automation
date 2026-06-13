-- Migration: 001_initial_schema
-- Run this in the Supabase SQL editor for the "slack-availability" project.

create table public.users (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text not null,
  slack_workspace_id text not null,
  email text unique,
  display_name text,
  user_token text,
  token_scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slack_user_id, slack_workspace_id)
);

create table public.availability_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  raw_command text not null,
  status_text text,
  status_emoji text,
  duration_minutes integer,
  expires_at timestamptz,
  channel_message_ts text,
  success boolean not null default false,
  error_message text,
  created_at timestamptz not null default now()
);

-- Index for quick lookup of logs per user
create index availability_logs_user_id_idx on public.availability_logs(user_id);
-- Index for chronological log queries
create index availability_logs_created_at_idx on public.availability_logs(created_at desc);
