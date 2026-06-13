// Status presets map.
// Keys are the command keywords (lowercase). Values are the Slack status fields.
// Order matters: longer keys must come before shorter ones so matching is unambiguous.
const PRESETS = new Map([
  ['leaving early', { text: 'Leaving early', emoji: ':runner:' }],
  ['sick',          { text: 'Out sick',      emoji: ':face_with_thermometer:' }],
  ['unavailable',   { text: 'Unavailable',   emoji: ':no_entry:' }],
  ['focus',         { text: 'Focus time',    emoji: ':headphones:' }],
  ['lunch',         { text: 'Lunch',         emoji: ':fork_and_knife:' }],
  ['meeting',       { text: 'In a meeting',  emoji: ':calendar:' }],
])

const PRESET_KEYS = Array.from(PRESETS.keys())

module.exports = { PRESETS, PRESET_KEYS }
