import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeServiceCandidate,
  canonicalJson,
  parseRoutingServerInfo,
  promoteServiceCandidate,
  verifyRoutingSignature
} from '../src/services/routing.ts'

const base64Url = (value: ArrayBuffer) => Buffer.from(value).toString('base64url')

test('verifies a signed V2 snapshot and rotates API/IM candidates independently', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = base64Url(await crypto.subtle.exportKey('raw', keys.publicKey))
  const now = Date.now()
  const serverInfo = {
    schema_version: 2,
    route_pool_id: 'local-dev',
    route_pool_version: 3,
    routing_version: 9,
    server_time: new Date(now).toISOString(),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    stale_if_error_until: new Date(now + 120_000).toISOString(),
    policy: {
      mode: 'primary_backup', route_bundle_required: true, failover_scope: 'service',
      primary_route_id: 'primary', backup_route_ids: ['backup'], switch_cooldown_seconds: 0,
      connect_timeout_ms: 5000
    },
    routes: [
      {
        route_id: 'primary', route_version: 1, name: '主线', priority: 10, weight: 100,
        region: 'local', carrier: 'loopback', deployment_id: 'b8im-local',
        endpoints: {
          api_server_url: 'http://127.0.0.1:18888', im_server_url: 'ws://127.0.0.1:18787',
          upload_server_url: 'http://127.0.0.1:18888', web_server_url: 'http://127.0.0.1:16988'
        }
      },
      {
        route_id: 'backup', route_version: 1, name: '备线', priority: 20, weight: 100,
        region: 'local', carrier: 'loopback', deployment_id: 'b8im-local',
        endpoints: {
          api_server_url: 'http://127.0.0.1:18889', im_server_url: 'ws://127.0.0.1:18788',
          upload_server_url: 'http://127.0.0.1:18889', web_server_url: 'http://127.0.0.1:16988'
        }
      }
    ]
  }
  const payload = {
    organization: 1, deployment_id: 'b8im-local', enterprise_code: 'org_1',
    client_family: 'web', server_info: serverInfo
  }
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(canonicalJson(payload)))
  await verifyRoutingSignature(payload, {
    alg: 'Ed25519', kid: 'routing-test-1', canonicalization: 'JCS-RFC8785', value: base64Url(signature)
  }, { 'routing-test-1': publicKey })

  const parsed = parseRoutingServerInfo(serverInfo, 'b8im-local', (value) => value.replace(/\/+$/, ''))
  const config = { organization: '1', serverInfo: parsed }
  assert.equal(activeServiceCandidate(config, 'api').routeId, 'primary')
  assert.equal(activeServiceCandidate(config, 'im').routeId, 'primary')
  assert.equal(promoteServiceCandidate(config, 'api', 'primary').routeId, 'backup')
  assert.equal(activeServiceCandidate(config, 'api').url, 'http://127.0.0.1:18889')
  assert.equal(activeServiceCandidate(config, 'im').url, 'ws://127.0.0.1:18787')
  assert.equal(promoteServiceCandidate(config, 'im', 'primary').url, 'ws://127.0.0.1:18788')
})

test('rejects a signature produced for another organization', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = base64Url(await crypto.subtle.exportKey('raw', keys.publicKey))
  const signed = { organization: 1 }
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(canonicalJson(signed)))
  await assert.rejects(() => verifyRoutingSignature(
    { organization: 2 },
    { alg: 'Ed25519', kid: 'routing-test-2', canonicalization: 'JCS-RFC8785', value: base64Url(signature) },
    { 'routing-test-2': publicKey }
  ), /签名验证失败/)
})
