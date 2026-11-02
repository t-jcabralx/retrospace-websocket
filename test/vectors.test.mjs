import test from 'node:test'
import assert from 'node:assert/strict'
import { signTicket, verifyTicket } from '../src/ticket.mjs'
import { authorizeSignature } from '../src/siteAuth.mjs'

// Known answers produced by the website's own code (its test/rt-authorize.test.mjs holds the same two constants). If the website's signing
// ever changes, one of the two suites fails and the change is noticed before anybody's connection is.
const SECRET = 'test-secret'
const CODE = 'ABC234'
const UID = 'KM-AAAA-BBBB-CCCC'

test('a ticket is signed exactly as the website signs it', () => {
  assert.equal(signTicket(SECRET, CODE, UID, 1_700_000_000_000), '1700001800000.e959cb9c10caf67817c313f4058aa6df')
  assert.equal(verifyTicket(SECRET, CODE, UID, '1700001800000.e959cb9c10caf67817c313f4058aa6df', 1_700_000_000_000 + 1000), 1_700_001_800_000)
})

test('a question to the website is signed exactly as the website checks it', () => {
  assert.equal(authorizeSignature(SECRET, 1_700_000_000_000, CODE, UID), '715045da2f6274b02215d3fdad94f4ac9317bfbcb43f11a05b78d5e464aa0bf4')
})

test('tickets: expired, for somebody else, for another board, another secret, or malformed are all refused', () => {
  const tok = signTicket(SECRET, CODE, UID, 1_000, 5_000)
  assert.equal(verifyTicket(SECRET, CODE, UID, tok, 5_999), 6_000)
  assert.equal(verifyTicket(SECRET, CODE, UID, tok, 6_000), null, 'expired')
  assert.equal(verifyTicket(SECRET, CODE, 'KM-2222-3333-4444', tok, 2_000), null)
  assert.equal(verifyTicket(SECRET, 'ZZZZ22', UID, tok, 2_000), null)
  assert.equal(verifyTicket('another', CODE, UID, tok, 2_000), null)
  for (const bad of [undefined, null, '', 'x', '123.abc', `${tok}0`, tok.replace('.', ':')]) assert.equal(verifyTicket(SECRET, CODE, UID, bad, 2_000), null, String(bad))
})
