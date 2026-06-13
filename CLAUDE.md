# Slack Availability Sync App

## Problem Statement

Strativ employees currently share availability updates in the main Strativ Slack workspace's `#availability` channel using messages such as:

- Out sick
- Unavailable for 1 hour
- Leaving early
- In a meeting
- Focus time

This workflow creates several operational issues:

- Many employees have the `#availability` channel muted, so important availability updates are missed.
- When someone needs to contact a colleague urgently, they often send a direct message first and only check `#availability` later if they do not receive a reply.
- This causes delays, especially when another available team member could have been contacted earlier.
- Strativ employees are members of multiple Slack workspaces, but not all workspaces have an availability channel.
- Employees often forget to update their Slack status across all workspaces, or it becomes inconvenient to do it manually.
- Employees use the same company email address across different Slack workspaces, which makes email-based user mapping possible.

## Updated Product Direction

- The solution should not start with a browser extension.
- The solution should not detect or sync manual Slack status changes made from Slack's default profile/status UI.
- The system should be built as a Slack command-based availability sync app with a backend.

Users should update their availability through a Slack slash command, such as:

```text
/availability unavailable 1h
```

When the command is submitted, the backend should update the user's Slack status across connected Slack workspaces and post a standardized message only in the Strativ main workspace's `#availability` channel.

## Proposed Solution

Build a Slack app that allows employees to update availability once using a slash command. The system should then:

- Update the employee's Slack status in the Strativ workspace.
- Sync the same Slack status to other connected Slack workspaces.
- Post an availability message only in the Strativ main workspace's `#availability` channel.
- Use company email to map the same employee across different Slack workspaces.
- Support duration-based statuses and clearing statuses.
- Treat the Strativ workspace as the source of truth for availability communication.

Other workspaces should only receive synced Slack status updates. No availability channel messages should be posted outside the Strativ workspace.

## Core Rule

Status syncing should happen only when the user uses the `/availability` command.

If a user manually changes their Slack status using Slack's default profile/status UI, the system should ignore that change.

Manual Slack status detection can be considered later, but it is not part of version 1.

## Example User Commands

The app should support commands like:

```text
/availability unavailable 1h
/availability sick today
/availability lunch 1h
/availability focus 2h
/availability meeting 30m
/availability leaving early at 4pm
/availability clear
```

## Core Workflow

When a user submits:

```text
/availability unavailable 1h
```

The system should:

1. Receive the slash command in the backend.
2. Verify the request came from Slack.
3. Identify the Slack user and workspace.
4. Retrieve the user's company email.
5. Use the email address to map the same user across connected Slack workspaces.
6. Parse the command into structured status data:
   - Status text
   - Status emoji
   - Duration
   - Expiration time
7. Update the user's Slack status in the Strativ workspace.
8. Update the user's Slack status in other connected workspaces.
9. Post a standardized availability message in Strativ `#availability`.
10. Return a confirmation message to the user in Slack.

## Example Output

If Rafee runs:

```text
/availability unavailable 1h
```

The system should update Rafee's Slack status in all connected workspaces and post the following message only in Strativ `#availability`:

```text
Rafee is unavailable for 1 hour.
Expected back: 3:30 PM.
```

The user should receive a private confirmation:

```text
Your availability has been updated.
Status: Unavailable for 1 hour
Expected back: 3:30 PM
Synced workspaces: Strativ, Client Workspace A, Partner Workspace B
Posted in: #availability
```

If one workspace fails to sync, the confirmation should mention it:

```text
Your Strativ availability was updated, but sync failed for Client Workspace A. Please reconnect that workspace.
```

## Workspace Behavior

### Strativ Main Workspace

The Strativ workspace is the primary workspace.

Actions in this workspace:

- Accept `/availability` command.
- Update user's Slack status.
- Post availability message in `#availability`.
- Store availability status as the source of truth.
- Sync status to other connected workspaces.

### Other Connected Workspaces

Other workspaces are sync targets only.

Actions in other workspaces:

- Receive synced Slack status updates.
- Do not receive availability channel messages.
- Do not require an availability channel.
- Be mapped using the user's company email.

## User Mapping

All employees use the same company email across Slack workspaces.

The system should use company email as the primary identifier for user mapping.

Example:

| Company Email          | Workspace           | Slack User ID |
| ---------------------- | ------------------- | ------------- |
| rafee.niloy@strativ.se | Strativ             | U123          |
| rafee.niloy@strativ.se | Client Workspace A  | U456          |
| rafee.niloy@strativ.se | Partner Workspace B | U789          |

Slack user IDs are different per workspace, so Slack user ID should not be used as the global identifier.

## Required Backend

A backend is required for this solution.

The backend should handle:

- Slack slash command endpoint
- Slack request verification
- Slack OAuth flow
- Workspace connection management
- User email mapping
- Secure token storage
- Status parsing logic
- Slack status update API calls
- Strativ `#availability` channel posting
- Sync logs and error handling
- Status expiry and clear command support

## Suggested Backend Components

### API Layer

Handles:

- Slash command endpoint
- OAuth callback
- Workspace connection requests
- Admin configuration
- Health check

### Database

Stores:

- Users
- Company emails
- Connected workspaces
- Slack workspace IDs
- Workspace names
- Slack user IDs per workspace
- OAuth tokens
- Availability channel ID
- Latest status
- Status expiration
- Sync logs
- Error logs

### Slack Integration Layer

Handles:

- `users.profile.set`
- `users.lookupByEmail`
- `chat.postMessage`
- OAuth token exchange
- Workspace/user lookup

### Scheduled Job or Queue

Handles:

- Optional status cleanup
- Retry failed syncs
- Expiry validation
- Sync audit logging

For MVP, Slack's native `status_expiration` can be used for automatic status clearing.

## Suggested Slack Scopes

The app will likely need the following Slack scopes:

| Scope                 | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `commands`            | Enable `/availability` slash command               |
| `users.profile:write` | Update the user's Slack status                     |
| `users.profile:read`  | Read current profile/status if needed              |
| `users:read.email`    | Map users across workspaces using company email    |
| `chat:write`          | Post messages in Strativ `#availability`           |
| `conversations:read`  | Find or configure the Strativ availability channel |

Final scopes should be validated during Slack app setup.

## Status Presets

The MVP should support the following presets:

| Command Keyword | Status Text   | Emoji | Duration Support |
| --------------- | ------------- | ----- | ---------------- |
| `sick`          | Out sick      | 🤒    | Yes              |
| `unavailable`   | Unavailable   | ⛔    | Yes              |
| `focus`         | Focus time    | 🎧    | Yes              |
| `lunch`         | Lunch         | 🍽️    | Yes              |
| `meeting`       | In a meeting  | 📅    | Yes              |
| `leaving early` | Leaving early | 🏃    | Yes              |
| `clear`         | Clear status  | None  | Not applicable   |

## Duration Handling

The command should support common duration formats:

- `1h`
- `30m`
- `2h`
- `today`
- `until 4pm`
- `at 4pm`

Examples:

```text
/availability unavailable 1h
/availability meeting 30m
/availability sick today
/availability leaving early at 4pm
```

The system should calculate:

- Status expiration timestamp
- Human-readable expected return time
- Slack `status_expiration`

## Clear Status Command

The app should support:

```text
/availability clear
```

This should:

- Clear the user's Slack status in Strativ.
- Clear the user's Slack status in connected workspaces.
- Optionally post in Strativ `#availability`:

```text
Rafee is available again.
```

For MVP, the "available again" channel message can be optional to avoid unnecessary channel noise.

## MVP Scope

Version 1 should include:

- Slack app setup
- `/availability` slash command
- Backend endpoint for Slack commands
- Slack request verification
- Slack OAuth
- User email retrieval
- Email-based user mapping across connected workspaces
- Status update in Strativ workspace
- Status sync to connected workspaces
- Message posting only in Strativ `#availability`
- Basic status presets
- Duration support
- `/availability clear`
- Basic sync success/failure message to the user
- Basic logging

## Out of Scope for Version 1

The following should not be included in version 1:

- Browser extension
- Manual Slack status detection
- Syncing statuses changed from Slack's default profile/status UI
- Google Calendar integration
- Availability dashboard
- Backup teammate recommendation
- AI-based availability prediction
- Posting availability messages in non-Strativ workspaces
- Mobile app
- Advanced admin analytics

## Development Phases

### Phase 1: Strativ-only MVP

Estimated time: 1 to 2 weeks

Build:

- Slack app
- `/availability` command
- Backend endpoint
- Update user Slack status in Strativ
- Post message in Strativ `#availability`
- Basic presets
- Duration handling
- `/availability clear`

### Phase 2: Multi-workspace Sync

Estimated time: 2 to 3 additional weeks

Build:

- OAuth connection for additional workspaces
- Email-based user mapping
- Status sync to connected workspaces
- Per-workspace sync logs
- User confirmation message with sync result

### Phase 3: Hardening

Estimated time: 1 to 3 additional weeks

Build:

- Admin channel configuration
- Better error handling
- Reconnect workspace flow
- Retry failed syncs
- Basic audit log
- Security review

## Estimated Timeline

| Version          | Scope                                                | Estimate     |
| ---------------- | ---------------------------------------------------- | ------------ |
| Basic MVP        | Strativ-only slash command and `#availability` post  | 1 to 2 weeks |
| Proper MVP       | Multi-workspace sync using company email             | 3 to 5 weeks |
| Production-ready | Logs, admin settings, retry handling, reconnect flow | 5 to 8 weeks |

## Recommended Build Order

Start with the Slack command backend.

Do not start with the browser extension.

Do not start with manual Slack status detection.

Recommended order:

1. `/availability` command in Strativ.
2. Status update in Strativ.
3. Message post in Strativ `#availability`.
4. Duration and clear command.
5. Multi-workspace OAuth.
6. Email-based workspace mapping.
7. Multi-workspace status sync.
8. Logs, reconnect flow, and hardening.

## Success Criteria

The MVP is successful if:

- A user can update availability using `/availability`.
- The user's Slack status updates in Strativ.
- The user's Slack status updates in all connected workspaces.
- A standardized availability message is posted only in Strativ `#availability`.
- The user receives a clear success/failure confirmation.
- Manual Slack status changes do not trigger syncing.
- The system works without a browser extension.
