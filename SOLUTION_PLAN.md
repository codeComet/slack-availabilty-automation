# Slack Availability Sync App — Phase 1 Solution Plan

## Intro

Internal Strativ project. Build the Phase 1 backend for a Slack slash command app that lets
employees update their availability using `/availability` in the Strativ workspace. The command
updates the user's Slack status and posts a standardized message to the `#availability` channel.

Stack: Node.js + Express, deployed on Vercel, backed by an existing Supabase (PostgreSQL)
project named `slack-availability`.

No frontend. All interaction happens inside Slack.

## Business need / Purpose

**Stakeholder:** All Strativ employees and team leads.

**Problem today:** Employees post availability updates in the `#availability` channel, but many
team members have it muted. When someone needs to reach a colleague urgently, they message
directly and check the channel only as a fallback — by which time the delay has already
occurred. There is no reliable, low-friction way to communicate availability in real time.

**What changes:** Employees run one slash command. Their Slack status updates immediately, and a
standardized message appears in `#availability`. Anyone checking a colleague's profile or the
channel sees a consistent, timely update.

**Priority bucket:** Internal operational improvement. Blocks Phase 2 (multi-workspace sync).

## Solution overview

Three components:

1. **Slack app** — slash command `/availability`, bot token for channel posting, OAuth for
   per-user profile tokens.
2. **Express backend on Vercel** — slash command endpoint, OAuth callback, Slack request
   verification, command parsing, Slack API calls.
3. **Supabase database** — stores users, their tokens, and an audit log.

### Approaches considered

**Pros**

| Node.js + Express on Vercel | Python + FastAPI |
|---|---|
| Lightweight, fast cold start | Strong async support |
| Same language as Slack's official Bolt SDK | Type hints for data models |
| Matches Strativ's frontend stack | |

**Cons**

| Node.js + Express on Vercel | Python + FastAPI |
|---|---|
| Manual signature verification | Slower cold start on Vercel |
| Need to handle raw body carefully | Less mature Slack ecosystem |

**Chosen: Node.js + Express** — matches Strativ's stack, Slack's SDK is Node-native, and
Vercel is optimized for Node serverless.

### Rollout

Single Vercel project, single deployment. The Slack app can be installed workspace-wide and
tested with one user before announcing to the team. No feature flags needed.

### Complexity

**Moderate complexity.** Three moving parts: Slack app config, Express API, Supabase schema.
The trickiest piece is the per-user OAuth flow — each user must authorize the app once before
their first `/availability` command can update their profile. Vercel's cold-start latency must
also be managed: Slack requires a 200 response within 3 seconds, so the handler must
acknowledge immediately and do the heavy work asynchronously via `response_url`.

### Challenges

- **3-second Slack timeout.** Slack retries if no 200 arrives within 3 seconds. The handler
  must return 200 immediately and post results via `response_url` afterward.
- **User token bootstrapping.** First-time users have no token. The flow must gracefully prompt
  them to authorize without throwing an error.
- **Raw body for signature verification.** Express's body parser must preserve the raw body;
  parsing it first destroys the signature check.

### References

- [CLAUDE.md — product spec](./CLAUDE.md)
- [Slack API — users.profile.set](https://api.slack.com/methods/users.profile.set)
- [Slack API — Verifying requests](https://api.slack.com/authentication/verifying-requests-from-slack)

---

## Step 1: Slack app setup

**Manual configuration in Slack's API dashboard — no code.**

Create the app at `api.slack.com/apps` → "From scratch". Name: `Availability Bot`.
Workspace: Strativ.

**Slash command:**

| Field | Value |
|---|---|
| Command | `/availability` |
| Request URL | `https://<vercel-domain>/api/slack/commands` |
| Short description | `Update your availability` |
| Usage hint | `[sick\|unavailable\|focus\|lunch\|meeting\|leaving early\|clear] [duration]` |

**OAuth scopes — Bot token scopes:**

| Scope | Purpose |
|---|---|
| `commands` | Receive slash command |
| `chat:write` | Post to `#availability` |
| `users:read` | Look up user info |
| `users:read.email` | Look up user by email (needed for Phase 2, add now) |

**OAuth scopes — User token scopes:**

| Scope | Purpose |
|---|---|
| `users.profile:write` | Update the user's own Slack status |

> Note: `users.profile.set` can only be called with a **user token**, not a bot token. Each
> employee must authorize the app once. The bot token is used only for `chat.postMessage`.

**OAuth redirect URL:** `https://<vercel-domain>/api/slack/oauth/callback`

**Environment variables** (set in Vercel project settings and `.env` locally):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SLACK_AVAILABILITY_CHANNEL_ID=C...
APP_URL=https://<vercel-domain>
```

**Dependencies:**

```bash
npm install express @slack/web-api @supabase/supabase-js
npm install --save-dev nodemon
```

---

## Step 2: Database schema

One migration on the existing `slack-availability` Supabase project.

### Table: `users`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` | |
| `slack_user_id` | `text` | NOT NULL | From slash command payload |
| `slack_workspace_id` | `text` | NOT NULL | From slash command payload |
| `email` | `text` | UNIQUE, NULLABLE | Retrieved via `users.info` |
| `display_name` | `text` | NULLABLE | For readable messages |
| `user_token` | `text` | NULLABLE | Set after OAuth; required for status updates |
| `token_scope` | `text` | NULLABLE | Stored for debugging |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |
| `updated_at` | `timestamptz` | NOT NULL, default `now()` | |

Unique constraint on `(slack_user_id, slack_workspace_id)`.

### Table: `availability_logs`

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `uuid` | PK, default `gen_random_uuid()` | |
| `user_id` | `uuid` | FK → `users.id`, NULLABLE | Null if user lookup failed |
| `raw_command` | `text` | NOT NULL | Full text after `/availability` |
| `status_text` | `text` | NULLABLE | Parsed status text |
| `status_emoji` | `text` | NULLABLE | Parsed emoji |
| `duration_minutes` | `integer` | NULLABLE | Parsed duration |
| `expires_at` | `timestamptz` | NULLABLE | Calculated expiration (UTC) |
| `channel_message_ts` | `text` | NULLABLE | Slack message timestamp |
| `success` | `boolean` | NOT NULL, default `false` | |
| `error_message` | `text` | NULLABLE | Set if any step failed |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | |

### Migration SQL

```sql
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
```

No Row Level Security in Phase 1 — server-side access only via service role key.

---

## Step 3: Project structure & Vercel config

```
/
├── api/
│   └── slack/
│       ├── commands.js           # POST /api/slack/commands
│       └── oauth/
│           └── callback.js       # GET /api/slack/oauth/callback
├── src/
│   ├── middleware/
│   │   └── verifySlack.js        # Slack request signature verification
│   ├── services/
│   │   ├── slackService.js       # Slack API calls (profile set, channel post)
│   │   └── userService.js        # User lookup / upsert in Supabase
│   ├── lib/
│   │   ├── supabase.js           # Supabase client singleton
│   │   └── slackClients.js       # Slack WebClient factory
│   ├── utils/
│   │   ├── parseCommand.js       # Command text → structured status object
│   │   └── parseDuration.js      # Duration string → minutes + expiry timestamp
│   └── config/
│       └── presets.js            # Status presets map
├── migrations/
│   └── 001_initial_schema.sql    # Migration from Step 2
├── .env.example
├── vercel.json
└── package.json
```

**`vercel.json`:**

```json
{
  "functions": {
    "api/**/*.js": {
      "maxDuration": 10
    }
  }
}
```

Vercel treats every file under `api/` as a serverless function. `maxDuration: 10` gives enough
headroom since the handler returns 200 immediately and finishes async work within that window.

**Rollback:** Revert the Vercel deployment via the Vercel dashboard. Previous deployments are
preserved automatically.

---

## Step 4: Slash command endpoint + Slack request verification

**Endpoint:** `POST /api/slack/commands`

Slack sends a URL-encoded body. Relevant fields:

```
command=/availability
text=unavailable 1h
user_id=U12345
team_id=T12345
user_name=rafee.niloy
response_url=https://hooks.slack.com/...
```

### Signature verification (`src/middleware/verifySlack.js`)

1. Read `X-Slack-Request-Timestamp` and `X-Slack-Signature` headers.
2. Reject if `|now() - timestamp| > 300` seconds (replay attack guard).
3. Build the base string: `v0:{timestamp}:{rawBody}`.
4. Compute `HMAC-SHA256(SLACK_SIGNING_SECRET, baseString)`.
5. Compare `v0={hash}` against `X-Slack-Signature` using `crypto.timingSafeEqual`.
6. Return 403 if mismatch.

**Important:** Express must receive the raw body, not parsed JSON. Configure:

```js
app.use('/api/slack/commands', express.raw({ type: 'application/x-www-form-urlencoded' }))
```

Parse the body inside the handler with:

```js
const params = new URLSearchParams(req.body.toString())
const text = params.get('text')
const userId = params.get('user_id')
const teamId = params.get('team_id')
const responseUrl = params.get('response_url')
```

### Handler flow (`api/slack/commands.js`)

```
1. Run verifySlack middleware → reject 403 on failure
2. Parse URL-encoded body
3. Send HTTP 200 with empty body immediately  ← must happen here, before any async work
4. Async (after 200 sent):
   a. Look up or create user in Supabase (upsert by slack_user_id + team_id)
   b. Check if user.user_token is set
   c. If no token:
      → Send DM via bot with OAuth link
      → Log to availability_logs (success: false, error: 'no_token')
      → Return
   d. Parse command text via parseCommand()
   e. If parse error:
      → POST ephemeral error to response_url
      → Log, return
   f. Execute: updateSlackStatus() + postToChannel()
   g. POST confirmation to response_url
   h. Log to availability_logs
```

### Confirmation messages (sent via `response_url` as ephemeral)

**Success:**
```
Your availability has been updated.
Status: Unavailable for 1 hour
Expected back: 3:30 PM
Posted in: #availability
```

**No token:**
```
Connect your Slack account first to use /availability.
Click here to authorize: https://<APP_URL>/api/slack/oauth/start?slack_user_id=U12345
```

**Unknown command:**
```
Unknown command. Try:
/availability [sick|unavailable|focus|lunch|meeting|leaving early|clear] [duration]

Examples:
  /availability unavailable 1h
  /availability meeting 30m
  /availability sick today
  /availability clear
```

**Partial failure (channel post failed):**
```
Your Slack status was updated, but posting to #availability failed.
Make sure the bot is invited to #availability.
```

---

## Step 5: User OAuth & token storage

`users.profile.set` requires a **user token** — a bot token cannot update another user's
profile. Each employee must authorize the app once.

### Flow

1. User runs `/availability` for the first time (no token stored).
2. Handler sends them a DM: "Connect your account: `<link>`".
3. Link: `https://<APP_URL>/api/slack/oauth/start?slack_user_id=U12345`
4. `GET /api/slack/oauth/start` redirects to Slack's OAuth URL:
   ```
   https://slack.com/oauth/v2/authorize
     ?client_id=<SLACK_CLIENT_ID>
     &user_scope=users.profile:write
     &redirect_uri=<APP_URL>/api/slack/oauth/callback
     &state=<slack_user_id>
   ```
5. User approves → Slack redirects to `GET /api/slack/oauth/callback?code=...&state=<user_id>`.
6. Backend exchanges `code` for token:
   ```
   POST https://slack.com/api/oauth.v2.access
   Body: client_id, client_secret, code, redirect_uri
   ```
7. Read `response.authed_user.access_token` and `response.authed_user.scope`.
8. `UPDATE users SET user_token = ..., token_scope = ..., updated_at = now()` where
   `slack_user_id = state`.
9. Return HTML: "Connected! Return to Slack and run /availability again."

### Uncertainty

Passing `slack_user_id` in OAuth `state` is the simplest approach but lacks CSRF protection.
Phase 3 hardening should replace this with a signed short-lived token (e.g. a JWT or a
random token stored in the DB with a 10-minute TTL).

---

## Step 6: Command parsing

### `src/config/presets.js`

```js
const PRESETS = {
  'sick':          { text: 'Out sick',      emoji: ':face_with_thermometer:' },
  'unavailable':   { text: 'Unavailable',   emoji: ':no_entry:' },
  'focus':         { text: 'Focus time',    emoji: ':headphones:' },
  'lunch':         { text: 'Lunch',         emoji: ':fork_and_knife:' },
  'meeting':       { text: 'In a meeting',  emoji: ':calendar:' },
  'leaving early': { text: 'Leaving early', emoji: ':runner:' },
}
```

### `src/utils/parseCommand.js`

Input: raw text string (e.g. `"unavailable 1h"`, `"leaving early at 4pm"`, `"clear"`).

**Algorithm:**

```
1. Trim and lowercase input.
2. If input === 'clear' → return { action: 'clear' }
3. Test against PRESET keys, longest-first (so "leaving early" matches before "leaving").
4. If no match → return { action: 'error', message: '...' }
5. Strip matched keyword from start of input. Remainder is the duration string.
6. Call parseDuration(remainder).
7. Return { action: 'set', statusText, emoji, durationMinutes, expiresAt, expiresUnix, humanReadable }
```

### `src/utils/parseDuration.js`

Input: duration string (e.g. `"1h"`, `"30m"`, `"today"`, `"at 4pm"`, `"until 4:30pm"`, `""`).

```
Parse rules (try in order):
  /^(\d+)h$/i        → durationMinutes = N * 60
  /^(\d+)m$/i        → durationMinutes = N
  /^today$/i         → expiresAt = today at 23:59:59 Europe/Stockholm
  /^(at|until) (.+)$/i → parse time string, expiresAt = today at that time Europe/Stockholm
  empty / no match   → durationMinutes = null, expiresAt = null (no expiry)

If durationMinutes is set and expiresAt is not:
  expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000)

expiresUnix = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : 0
  (Slack treats 0 as "no expiry")

humanReadable = expiresAt
  ? expiresAt.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' })
  : null
```

**Return shape:**

```js
{
  action: 'set',             // 'set' | 'clear' | 'error'
  statusText: 'Unavailable',
  emoji: ':no_entry:',
  durationMinutes: 60,       // null if no duration
  expiresAt: Date | null,
  expiresUnix: 1700000000,   // 0 if no expiry
  humanReadable: '15:30',    // null if no duration
  errorMessage: null         // set if action === 'error'
}
```

---

## Step 7: Slack status update + channel post

### `src/services/slackService.js`

Two operations executed in sequence. If the first fails, skip the second.

**A. Update user's Slack status** — uses the **user token**.

```js
const { WebClient } = require('@slack/web-api')

async function updateStatus(userToken, { statusText, emoji, expiresUnix }) {
  const client = new WebClient(userToken)
  await client.users.profile.set({
    profile: {
      status_text: statusText,
      status_emoji: emoji,
      status_expiration: expiresUnix   // 0 = no expiry
    }
  })
}
```

For `clear`:
```js
profile: { status_text: '', status_emoji: '', status_expiration: 0 }
```

**B. Post to `#availability`** — uses the **bot token**.

```js
async function postAvailabilityMessage(botClient, { displayName, statusText, humanReadable, action }) {
  const text = action === 'clear'
    ? `${displayName} is available again.`
    : humanReadable
      ? `${displayName} is ${statusText.toLowerCase()}.\nExpected back: ${humanReadable}.`
      : `${displayName} is ${statusText.toLowerCase()}.`

  const result = await botClient.chat.postMessage({
    channel: process.env.SLACK_AVAILABILITY_CHANNEL_ID,
    text
  })
  return result.ts   // message timestamp, stored in availability_logs
}
```

**Error handling:**
- If `updateStatus` throws → log error, respond with failure message, skip channel post.
- If `postAvailabilityMessage` throws → log error, confirm status was updated, include warning
  in the confirmation that channel post failed.

---

## Step 8: Logging

After every command, insert one row into `availability_logs`:

```js
await supabase.from('availability_logs').insert({
  user_id: user?.id ?? null,
  raw_command: commandText,
  status_text: parsed?.statusText ?? null,
  status_emoji: parsed?.emoji ?? null,
  duration_minutes: parsed?.durationMinutes ?? null,
  expires_at: parsed?.expiresAt?.toISOString() ?? null,
  channel_message_ts: channelTs ?? null,
  success: !hasError,
  error_message: errorMessage ?? null
})
```

Log on all outcomes: success, no token, parse error, API failure. This gives a full audit
trail and is the foundation for Phase 3's retry and reconnect flows.

---

## Remaining uncertainties

- **`SLACK_AVAILABILITY_CHANNEL_ID`** — needs to be looked up manually from the Strativ Slack
  workspace (right-click channel → Copy link, extract the ID from the URL). Can be hardcoded
  in env for Phase 1; Phase 3 adds admin config.
- **OAuth `state` CSRF protection** — passing `slack_user_id` in plain state is acceptable for
  an internal tool in Phase 1. Replace with a signed token in Phase 3.
- **Vercel cold starts** — on low-traffic periods the function may cold-start and risk the
  3-second window. Monitor in Vercel logs. If it becomes an issue, upgrade to a Vercel Pro
  plan (removes cold-start wait time) or move to Railway.
