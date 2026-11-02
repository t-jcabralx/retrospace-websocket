// The shapes of the ids the website hands out (a board's code, a person's id on it, one browser tab's id).
const UID_RE = /^KM-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/
const CODE_RE = /^[2-9A-HJKMNP-Z]{6}$/
export const isUid = (s) => typeof s === 'string' && UID_RE.test(s)
export const isCode = (s) => typeof s === 'string' && CODE_RE.test(s)
export const isCid = (s) => typeof s === 'string' && s.length <= 40 && /^[\w-]+$/.test(s)
// The channel the website publishes a board's changes on.
export const channelOf = (code) => `kb:${code}`
