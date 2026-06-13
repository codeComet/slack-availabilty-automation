const crypto = require('crypto')

/**
 * Express middleware that verifies a Slack request signature.
 *
 * Must run BEFORE any body parser — it reads req.body as raw bytes.
 * Configure the route with: express.raw({ type: 'application/x-www-form-urlencoded' })
 */
function verifySlack(req, res, next) {
  const timestamp = req.headers['x-slack-request-timestamp']
  const signature = req.headers['x-slack-signature']

  if (!timestamp || !signature) {
    return res.status(403).json({ error: 'Missing Slack signature headers' })
  }

  // Reject requests older than 5 minutes (replay attack guard)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > 300) {
    return res.status(403).json({ error: 'Request timestamp too old' })
  }

  const rawBody = req.body instanceof Buffer ? req.body.toString() : req.body

  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex')
  const expectedSignature = `v0=${hmac}`

  try {
    const sigBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expectedSignature)

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return res.status(403).json({ error: 'Invalid Slack signature' })
    }
  } catch {
    return res.status(403).json({ error: 'Signature verification failed' })
  }

  next()
}

module.exports = { verifySlack }
