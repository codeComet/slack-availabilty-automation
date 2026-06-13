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
  if (existing) return existing

  // New user — fetch display name from Slack
  let displayName = slackUserId
  let email = null
  try {
    const info = await botClient.users.info({ user: slackUserId })
    displayName = info.user?.profile?.display_name || info.user?.real_name || slackUserId
    email = info.user?.profile?.email || null
  } catch (err) {
    console.warn(`Could not fetch Slack user info for ${slackUserId}:`, err.message)
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({
      slack_user_id: slackUserId,
      slack_workspace_id: slackWorkspaceId,
      display_name: displayName,
      email,
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
