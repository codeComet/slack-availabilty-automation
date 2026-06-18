/**
 * Google Calendar service.
 *
 * Handles creating and deleting Out-of-Office events on a user's primary calendar.
 * Tokens are stored in the google_connections table and auto-refreshed as needed.
 */

const { google } = require('googleapis')
const supabase = require('../lib/supabase')

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/api/google/oauth/callback`
  )
}

/**
 * Returns an authorized OAuth2 client for the given company email,
 * or null if the user has not connected their Google account.
 *
 * @param {string} userEmail
 * @returns {Promise<import('googleapis').Auth.OAuth2Client | null>}
 */
async function getGoogleClient(userEmail) {
  const { data, error } = await supabase
    .from('google_connections')
    .select('access_token, refresh_token, token_expiry')
    .eq('user_email', userEmail)
    .maybeSingle()

  if (error) {
    console.error('Failed to fetch google_connections:', error.message)
    return null
  }
  if (!data?.refresh_token) return null

  const oauth2Client = makeOAuth2Client()
  oauth2Client.setCredentials({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.token_expiry ? new Date(data.token_expiry).getTime() : undefined,
  })

  // Persist any new access_token the library obtains via refresh
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await supabase
        .from('google_connections')
        .update({
          access_token: tokens.access_token,
          token_expiry: tokens.expiry_date
            ? new Date(tokens.expiry_date).toISOString()
            : null,
        })
        .eq('user_email', userEmail)
    }
  })

  return oauth2Client
}

/**
 * Creates an Out-of-Office event on the user's primary Google Calendar.
 *
 * @param {string} userEmail   Company email used to look up stored tokens
 * @param {string} startDate   Inclusive start date, "YYYY-MM-DD"
 * @param {string} endDate     Exclusive end date,   "YYYY-MM-DD"  (Google Calendar convention)
 * @returns {Promise<string>}  The created event's Google Calendar event ID
 */
async function createOOOEvent(userEmail, startDate, endDate) {
  const auth = await getGoogleClient(userEmail)
  if (!auth) throw new Error('Google account not connected')

  const calendar = google.calendar({ version: 'v3', auth })

  const { data } = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: 'Out of office',
      eventType: 'outOfOffice',
      start: { date: startDate },
      end:   { date: endDate },
      outOfOfficeProperties: {
        autoDeclineMode: 'declineAllConflictingInvitations',
        declineMessage: 'I am currently out of office and will respond when I return.',
      },
    },
  })

  return data.id
}

/**
 * Deletes a Google Calendar event by ID on the user's primary calendar.
 * Silently ignores "not found" errors (already deleted or never existed).
 *
 * @param {string} userEmail
 * @param {string} eventId    Google Calendar event ID
 * @returns {Promise<boolean>}  true if deleted, false if not connected
 */
async function deleteOOOEvent(userEmail, eventId) {
  const auth = await getGoogleClient(userEmail)
  if (!auth) return false

  const calendar = google.calendar({ version: 'v3', auth })

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    })
  } catch (err) {
    // 404 / 410 means the event is already gone — treat as success
    const status = err?.response?.status
    if (status !== 404 && status !== 410) throw err
  }

  return true
}

/**
 * Checks whether the given email has a connected Google account.
 *
 * @param {string} userEmail
 * @returns {Promise<boolean>}
 */
async function isGoogleConnected(userEmail) {
  if (!userEmail) return false
  const { data } = await supabase
    .from('google_connections')
    .select('refresh_token')
    .eq('user_email', userEmail)
    .maybeSingle()
  return !!data?.refresh_token
}

module.exports = { createOOOEvent, deleteOOOEvent, isGoogleConnected }
