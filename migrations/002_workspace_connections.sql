-- Migration: 002_workspace_connections
-- Adds multi-workspace sync support.
-- Each row = one user's OAuth token for one Slack workspace, keyed by company email.

create table public.workspace_connections (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,           -- company email — the cross-workspace key
  workspace_id text not null,         -- Slack team ID (T...)
  workspace_name text,                -- human-readable workspace name
  slack_user_id text not null,        -- user's Slack ID in THIS workspace (differs per workspace)
  access_token text not null,         -- user-scoped OAuth token (xoxp-...) for THIS workspace
  token_scope text,
  connected_at timestamptz not null default now(),
  unique (user_email, workspace_id)   -- one connection per user per workspace
);

create index workspace_connections_email_idx on public.workspace_connections(user_email);
