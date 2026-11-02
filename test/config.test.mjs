import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, envValue } from '../src/config.mjs'

const good = { RT_SECRET: 's3cret', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io/', UPSTASH_REDIS_REST_TOKEN: 'tok', SITE_URL: 'https://site.example/' }

test('a complete environment gives the settings, with defaults', () => {
  const c = loadConfig(good)
  assert.deepEqual([c.secret, c.upstash, c.siteUrl, c.allowedOrigins, c.port, c.maxConnections, c.maxLifetimeMs], ['s3cret', { url: 'https://x.upstash.io', token: 'tok' }, 'https://site.example', ['https://site.example'], 8080, 5000, 270_000])
})

test('everything that is missing is reported at once, and a bad address is named', () => {
  assert.throws(() => loadConfig({}), /RT_SECRET is not set; UPSTASH_REDIS_REST_URL is not set; UPSTASH_REDIS_REST_TOKEN is not set; SITE_URL is not set/)
  assert.throws(() => loadConfig({ ...good, SITE_URL: 'not a url' }), /SITE_URL is not a valid address/)
  assert.throws(() => loadConfig({ ...good, SITE_URL: 'ftp://site.example' }), /must start with https/)
})

test('values pasted with their quotes or spaces are cleaned, and the list of origins is trimmed', () => {
  assert.equal(envValue('A', { A: ' "x y" ' }), 'x y')
  const c = loadConfig({ ...good, RT_SECRET: '"quoted"', ALLOWED_ORIGINS: 'https://a.example/, https://b.example ,', PORT: '9000', MAX_CONNECTIONS: '10', RT_WS_MAX_MS: '1000' })
  assert.deepEqual([c.secret, c.allowedOrigins, c.port, c.maxConnections, c.maxLifetimeMs], ['quoted', ['https://a.example', 'https://b.example'], 9000, 10, 1000])
  assert.equal(loadConfig({ ...good, PORT: 'abc' }).port, 8080)
})
