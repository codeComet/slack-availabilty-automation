// Status presets map.
// Keys are the command keywords (lowercase). Values are the Slack status fields.
// Order matters: longer keys must come before shorter ones so matching is unambiguous.
const PRESETS = new Map([
  ['leaving early', { text: 'Leaving early', emoji: ':runner:',                channelPhrase: 'is leaving early' }],
  ['sick',          { text: 'Out sick',      emoji: ':face_with_thermometer:', channelPhrase: 'is out sick' }],
  ['unavailable',   { text: 'Unavailable',   emoji: ':no_entry:',             channelPhrase: 'is unavailable' }],
  ['focus',         { text: 'Focus time',    emoji: ':headphones:',           channelPhrase: 'is on focus time' }],
  ['lunch',         { text: 'Lunch',         emoji: ':fork_and_knife:',       channelPhrase: 'is at lunch' }],
  ['meeting',       { text: 'In a meeting',  emoji: ':calendar:',             channelPhrase: 'is in a meeting' }],
])

const PRESET_KEYS = Array.from(PRESETS.keys())

module.exports = { PRESETS, PRESET_KEYS }
