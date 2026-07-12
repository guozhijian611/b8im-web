import assert from 'node:assert/strict'
import {
  canonicalJson,
  parseRoutingServerInfo,
  serviceCandidates,
  verifyRoutingSignature
} from '../src/services/routing.ts'

const discoveryBase = process.env.DISCOVERY_BASE ?? 'http://127.0.0.1:18889'
const enterpriseCode = process.env.ENTERPRISE_CODE ?? 'org_1'
const kid = process.env.ROUTING_KID
const publicKey = process.env.ROUTING_PUBLIC_KEY
assert.ok(kid && publicKey, 'ROUTING_KID and ROUTING_PUBLIC_KEY are required')

const query = `/saimulti/appInfo?enterprise_code=${encodeURIComponent(enterpriseCode)}&client_family=web`
const discoveryResponse = await fetch(new URL(query, discoveryBase), { signal: AbortSignal.timeout(3000) })
assert.equal(discoveryResponse.ok, true, `discovery HTTP ${discoveryResponse.status}`)
const envelope = await discoveryResponse.json()
assert.equal(envelope.code, 200)
const data = envelope.data
const payload = {
  organization: data.organization,
  deployment_id: data.deployment_id,
  enterprise_code: data.enterprise_code,
  client_family: data.client_family,
  server_info: data.server_info
}
await verifyRoutingSignature(payload, data.routing_signature, { [kid]: publicKey })
const parsed = parseRoutingServerInfo(data.server_info, data.deployment_id, (value) => value.replace(/\/+$/, ''))

const failures = []
let selected = null
for (const candidate of serviceCandidates({ organization: String(data.organization), serverInfo: parsed }, 'api')) {
  try {
    const response = await fetch(new URL(query, candidate.url), { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const result = await response.json()
    if (result.code !== 200) throw new Error(`code ${result.code}`)
    selected = candidate
    break
  } catch (error) {
    failures.push({ route_id: candidate.routeId, reason: error instanceof Error ? error.name : 'unknown' })
  }
}

assert.ok(selected, '所有 API 线路均不可用')
if (process.env.REQUIRE_FAILOVER === '1') {
  assert.ok(failures.length >= 1, '主线路没有失败，未触发故障切换')
  assert.notEqual(selected.routeId, parsed.policy.primaryRouteId, '仍然选择了主线路')
}
console.log(JSON.stringify({
  ok: true,
  canonical_length: canonicalJson(payload).length,
  failed_routes: failures,
  selected_route: selected.routeId,
  selected_url: selected.url
}))
