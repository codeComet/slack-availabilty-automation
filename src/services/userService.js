const supabase = require('../lib/supabase')
const { botClient } = require('../lib/slackClients')

/**
 * Finds or creates a user row in Supabase.
 * On first encounter, fetches the user's display name from Slack.
 *
 * @param {{ slackUserId: string, slackWorkspaceId: string }} params
 * @returns {Promise<object>}  The users row
 */
async function findOrCreateUser({ slackUserId, slackWorkspaceId }) {
  // Try to find existing user
  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select('*')
    .eq('slack_user_id', slackUserId)
    .eq('slack_workspace_id', slackWorkspaceId)
    .maybeSingle()

  if (selectError) throw selectError
  if (existing) {
    // Backfill avatar_url if missing — fire-and-forget so it never blocks the command response
    if (!existing.avatar_url) {
      botClient.users.info({ user: slackUserId })
        .then(info => {
          const avatarUrl = info.user?.profile?.image_72 || null
          if (avatarUrl) {
            supabase.from('users').update({ avatar_url: avatarUrl }).eq('id', existing.id).then(() => {})
          }
        })
        .catch(() => {})
    }
    return existing
  }

  // New user — fetch display name, email, and avatar from Slack
  let displayName = slackUserId
  let email = null
  let avatarUrl = null
  try {
    const info = await botClient.users.info({ user: slackUserId })
    displayName = info.user?.profile?.display_name || info.user?.real_name || slackUserId
    email = info.user?.profile?.email || null
    avatarUrl = info.user?.profile?.image_72 || null
  } catch (err) {
    console.warn(`Could not fetch Slack user info for ${slackUserId}:`, err.message)
  }

  // Check if user already exists with this email (e.g. migrated from another workspace)
  if (email) {
    const { data: byEmail } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle()

    if (byEmail) {
      // Update their primary workspace to the current one and return
      const { data: updated } = await supabase
        .from('users')
        .update({
          slack_user_id: slackUserId,
          slack_workspace_id: slackWorkspaceId,
          display_name: displayName,
          avatar_url: avatarUrl,
          updated_at: new Date().toISOString(),
        })
        .eq('email', email)
        .select()
        .single()
      return updated || byEmail
    }
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({
      slack_user_id: slackUserId,
      slack_workspace_id: slackWorkspaceId,
      display_name: displayName,
      email,
      avatar_url: avatarUrl,
    })
    .select()
    .single()

  if (insertError) throw insertError
  return created
}

/**
 * Saves a user token after OAuth.
 *
 * @param {string} slackUserId
 * @param {string} userToken
 * @param {string} tokenScope
 */
async function saveUserToken(slackUserId, userToken, tokenScope) {
  const { error } = await supabase
    .from('users')
    .update({ user_token: userToken, token_scope: tokenScope, updated_at: new Date().toISOString() })
    .eq('slack_user_id', slackUserId)

  if (error) throw error
}

/**
 * Finds a user by slack_user_id only (used during OAuth callback).
 *
 * @param {string} slackUserId
 */
async function findUserBySlackId(slackUserId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  if (error) throw error
  return data
}

module.exports = { findOrCreateUser, saveUserToken, findUserBySlackId }
