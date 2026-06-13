# Availability Bot — User Manual

The Availability Bot lets you update your Slack status and notify the team in one command. Instead of manually updating your status and posting in `#availability`, you run a single slash command and the bot handles both.

---

## First-time setup

Before your first use, you need to connect your Slack account. This is a one-time step.

1. In any Slack channel, type `/availability` and press Enter.
2. The bot will reply privately with a **"Connect your account"** link.
3. Click the link — it opens a Slack authorization page.
4. Click **Allow**.
5. You'll see a "You're connected!" confirmation page.
6. Return to Slack. You're all set.

You will never be asked to connect again.

---

## How it works

When you run a command, the bot:

- Updates your Slack status (emoji + text) across connected workspaces.
- Posts a message in `#availability` so the team knows your status at a glance.
- Sends you a private confirmation with the details.

---

## Commands

### Update your status

```
/availability [status] [duration]
```

**Available statuses:**

| Command | Status shown | Emoji |
|---|---|---|
| `sick` | Out sick | 🤒 |
| `unavailable` | Unavailable | ⛔ |
| `focus` | Focus time | 🎧 |
| `lunch` | Lunch | 🍽️ |
| `meeting` | In a meeting | 📅 |
| `leaving early` | Leaving early | 🏃 |

---

### Clear your status

```
/availability clear
```

Clears your Slack status across all connected workspaces.

---

## Duration formats

You can add a duration to any status command:

| Format | Meaning | Example |
|---|---|---|
| `1h` | Hours | `/availability focus 2h` |
| `30m` | Minutes | `/availability meeting 30m` |
| `today` | Until end of day | `/availability sick today` |
| `at 4pm` | Until a specific time | `/availability leaving early at 4pm` |
| `until 3pm` | Until a specific time | `/availability unavailable until 3pm` |
| *(no duration)* | No expiry | `/availability lunch` |

When a duration is set, your Slack status automatically clears at the expiry time.

---

## Examples

```
/availability unavailable 1h
```
Sets status to ⛔ Unavailable for 1 hour. Posts in `#availability`:
> Bishal is unavailable. Expected back: 14:30.

---

```
/availability meeting 30m
```
Sets status to 📅 In a meeting for 30 minutes. Posts in `#availability`:
> Bishal is in a meeting. Expected back: 13:15.

---

```
/availability sick today
```
Sets status to 🤒 Out sick until end of day. Posts in `#availability`:
> Bishal is out sick. Expected back: 23:59.

---

```
/availability focus 2h
```
Sets status to 🎧 Focus time for 2 hours. The team knows not to disturb you.

---

```
/availability leaving early at 4pm
```
Sets status to 🏃 Leaving early, clears automatically at 4:00 PM.

---

```
/availability clear
```
Clears your status. Posts in `#availability`:
> Bishal is available again.

---

## What the team sees

**In `#availability`:** A single standardized message every time you update your status. No more inconsistent formatting — everyone posts the same way.

**On your Slack profile:** Your status emoji and text update instantly. Anyone who hovers over your name in any channel sees your current availability.

---

## Tips

- **You only need to run one command.** The bot updates your status and posts in `#availability` simultaneously.
- **Duration is optional.** If you skip it, your status stays until you manually clear it with `/availability clear`.
- **All times are in Stockholm time (CET/CEST).**
- **The bot reply is only visible to you.** The confirmation message after each command is private — your teammates only see the `#availability` post.
