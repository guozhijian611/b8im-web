#!/usr/bin/env node
/**
 * Fail the Docker/image build when production assets did not receive
 * VITE_PLATFORM_DEFAULT_HOSTS / VITE_ROUTING_PUBLIC_KEYS correctly.
 */
import fs from 'node:fs'
import path from 'node:path'

const assetsDir = path.resolve('dist/assets')
const file = fs.readdirSync(assetsDir).find((name) => /^index-.*\.js$/.test(name))
if (!file) {
  console.error('verify-production-env: no dist/assets/index-*.js')
  process.exit(2)
}

const source = fs.readFileSync(path.join(assetsDir, file), 'utf8')

function readEnvLiteral(key) {
  const match = source.match(new RegExp(`${key}:((?:'(?:\\\\.|[^'])*'|"(?:\\\\.|[^"])*"))`))
  if (!match) return null
  try {
    return Function(`return (${match[1]})`)()
  } catch (error) {
    console.error(`verify-production-env: cannot evaluate ${key}`, error)
    process.exit(4)
  }
}

const hosts = readEnvLiteral('VITE_PLATFORM_DEFAULT_HOSTS')
if (typeof hosts !== 'string' || !hosts.trim()) {
  console.error('verify-production-env: VITE_PLATFORM_DEFAULT_HOSTS missing or empty in', file)
  process.exit(3)
}

const keysRaw = readEnvLiteral('VITE_ROUTING_PUBLIC_KEYS')
if (typeof keysRaw !== 'string' || !keysRaw.trim()) {
  console.error('verify-production-env: VITE_ROUTING_PUBLIC_KEYS missing or empty in', file)
  process.exit(5)
}

let parsed
try {
  parsed = JSON.parse(keysRaw)
} catch (error) {
  console.error(
    'verify-production-env: VITE_ROUTING_PUBLIC_KEYS is not valid JSON at runtime:',
    JSON.stringify(keysRaw)
  )
  console.error(error)
  process.exit(6)
}

if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
  console.error('verify-production-env: keys must be a non-empty object:', parsed)
  process.exit(7)
}

console.log(
  'verify-production-env: ok',
  file,
  'hosts=',
  hosts,
  'kids=',
  Object.keys(parsed).join(',')
)
