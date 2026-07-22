import assert from 'node:assert/strict'
import test from 'node:test'
import { WebApiError } from '../src/services/apiClient.ts'
import {
  checkFileMediaUpload,
  fetchFileMediaUsage,
  formatFileMediaByteCount,
  formatFileMediaQuotaByteCount,
  formatFileMediaUsageRatio,
  parseFileMediaUploadCheck,
  parseFileMediaUsage
} from '../src/services/fileMedia.ts'
import type { TenantBrandConfig } from '../src/services/tenantConfig.ts'
import type { WebImSession } from '../src/types.ts'

const config = {
  organization: '901',
  discovered: true,
  serverInfo: {
    routingVersion: 1,
    routes: [{
      routeId: 'primary',
      endpoints: {
        apiServerUrl: 'https://api.example.test',
        imServerUrl: 'wss://ws.example.test',
        uploadServerUrl: 'https://api.example.test',
        webServerUrl: 'https://web.example.test'
      }
    }],
    apiServerUrl: 'https://api.example.test'
  }
} as TenantBrandConfig

const session = {
  accessToken: '',
  organization: '901',
  user: { userId: 'file-media-user' }
} as WebImSession

const storage = {
  organization: 901,
  quota_key: 'storage_bytes',
  quota_value: '10000',
  used_value: '6000',
  held_value: '500',
  occupancy_value: '6500',
  remaining_value: '3500',
  unlimited: false,
  used_file_count: 6,
  held_file_count: 1,
  usage_ratio: 0.65,
  version: 3,
  update_time: null
} as const

const policy = {
  max_file_bytes: '2147483648',
  large_file_enabled: 1,
  preview_enabled: 0,
  status: 1
} as const

function apiResponse(data: unknown, status = 200, code = 200) {
  return new Response(JSON.stringify({ code, data, message: code === 200 ? 'ok' : 'unavailable' }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function withFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>
) {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  Object.assign(globalThis, { window: globalThis })
  globalThis.fetch = handler
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
}

test('usage accepts only the exact nested storage and four-field policy DTOs', async () => {
  const expected = { storage, policy }
  assert.deepEqual(parseFileMediaUsage(expected, config.organization), expected)

  await withFetch(async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/saimulti/web/file-media/usage')
    assert.equal(init?.method, 'GET')
    return apiResponse(expected)
  }, async () => {
    assert.deepEqual(await fetchFileMediaUsage(config, session), expected)
  })
})

test('usage rejects flat quota data, numeric decimal fields, and mixed policy capacity fields', () => {
  assert.throws(
    () => parseFileMediaUsage({ ...storage, ...policy }, config.organization),
    /FileMediaUsage 字段集合无效/
  )
  assert.throws(
    () => parseFileMediaUsage({
      storage: { ...storage, quota_value: 10000 },
      policy
    }, config.organization),
    /StorageQuota\.quota_value 必须是规范十进制字符串/
  )
  assert.throws(
    () => parseFileMediaUsage({
      storage,
      policy: { ...policy, organization: 901 }
    }, config.organization),
    /FileMediaPolicy 字段集合无效/
  )
})

test('checkUpload rejects size aliases and legacy quota wrappers', () => {
  const exact = {
    allowed: false,
    reason: '存储配额不足。',
    size_bytes: 4096,
    storage,
    policy
  }
  assert.deepEqual(parseFileMediaUploadCheck(exact, config.organization, 4096), exact)

  const withoutSize: Record<string, unknown> = { ...exact }
  delete withoutSize.size_bytes
  assert.throws(
    () => parseFileMediaUploadCheck(
      { ...withoutSize, size: 4096 },
      config.organization,
      4096
    ),
    /FileMediaUploadCheck 字段集合无效/
  )
  assert.throws(
    () => parseFileMediaUploadCheck(
      { ...exact, quota: storage },
      config.organization,
      4096
    ),
    /FileMediaUploadCheck 字段集合无效/
  )
})

test('usage binds StorageQuota to the exact tenant organization at parser and HTTP layers', async () => {
  const wrongOrganization = {
    storage: { ...storage, organization: 902 },
    policy
  }
  assert.throws(
    () => parseFileMediaUsage(wrongOrganization, config.organization),
    /organization 与 TenantBrandConfig\.organization 不一致/
  )

  await withFetch(
    async () => apiResponse(wrongOrganization),
    async () => {
      await assert.rejects(
        fetchFileMediaUsage(config, session),
        /organization 与 TenantBrandConfig\.organization 不一致/
      )
    }
  )
})

test('usage ratio is the exact six-decimal BigInt-derived server ratio', () => {
  const largeStorage = {
    ...storage,
    quota_value: '9007199254740993',
    used_value: '3002399751580331',
    held_value: '0',
    occupancy_value: '3002399751580331',
    remaining_value: '6004799503160662',
    usage_ratio: 0.333333
  }
  assert.deepEqual(
    parseFileMediaUsage({ storage: largeStorage, policy }, config.organization),
    { storage: largeStorage, policy }
  )
  assert.throws(
    () => parseFileMediaUsage({
      storage: { ...largeStorage, usage_ratio: 0.333334 },
      policy
    }, config.organization),
    /使用率与占用值不一致/
  )

  const halfUpTieStorage = {
    ...storage,
    quota_value: '2000000',
    used_value: '1',
    held_value: '0',
    occupancy_value: '1',
    remaining_value: '1999999',
    usage_ratio: 0.000001
  }
  assert.deepEqual(
    parseFileMediaUsage({ storage: halfUpTieStorage, policy }, config.organization),
    { storage: halfUpTieStorage, policy },
    '0.0000005 must round half-up to 0.000001'
  )
  assert.throws(
    () => parseFileMediaUsage({
      storage: { ...halfUpTieStorage, usage_ratio: 0 },
      policy
    }, config.organization),
    /使用率与占用值不一致/
  )

  const unlimitedStorage = {
    ...storage,
    quota_value: '0',
    remaining_value: null,
    unlimited: true,
    usage_ratio: null
  }
  assert.deepEqual(
    parseFileMediaUsage({ storage: unlimitedStorage, policy }, config.organization),
    { storage: unlimitedStorage, policy }
  )
  assert.throws(
    () => parseFileMediaUsage({
      storage: { ...unlimitedStorage, usage_ratio: 0 },
      policy
    }, config.organization),
    /无限配额剩余值或使用率无效/
  )
})

test('usage HTTP call rejects a hostile ratio even when all other fields are coherent', async () => {
  await withFetch(
    async () => apiResponse({
      storage: { ...storage, usage_ratio: 0.650001 },
      policy
    }),
    async () => {
      await assert.rejects(
        fetchFileMediaUsage(config, session),
        /使用率与占用值不一致/
      )
    }
  )
})

test('checkUpload binds returned size and allowed/reason semantics without trimming reason', () => {
  const denied = {
    allowed: false,
    reason: '  存储配额不足。  ',
    size_bytes: 4096,
    storage,
    policy
  }
  assert.equal(
    parseFileMediaUploadCheck(denied, config.organization, 4096).reason,
    denied.reason
  )
  assert.deepEqual(
    parseFileMediaUploadCheck(
      { ...denied, allowed: true, reason: '' },
      config.organization,
      4096
    ).allowed,
    true
  )
  assert.throws(
    () => parseFileMediaUploadCheck(
      { ...denied, allowed: true },
      config.organization,
      4096
    ),
    /allowed 与 reason 不一致/
  )
  assert.throws(
    () => parseFileMediaUploadCheck(
      { ...denied, reason: '   ' },
      config.organization,
      4096
    ),
    /allowed 与 reason 不一致/
  )
  assert.throws(
    () => parseFileMediaUploadCheck(denied, config.organization, 4097),
    /size_bytes 与请求值不一致/
  )
})

test('checkUpload rejects a hostile HTTP response with a different requested size', async () => {
  await withFetch(
    async () => apiResponse({
      allowed: true,
      reason: '',
      size_bytes: 4097,
      storage,
      policy
    }),
    async () => {
      await assert.rejects(
        checkFileMediaUpload(config, session, 4096),
        /size_bytes 与请求值不一致/
      )
    }
  )
})

test('checkUpload HTTP call rejects hostile allowed/reason combinations', async () => {
  await withFetch(
    async () => apiResponse({
      allowed: false,
      reason: '   ',
      size_bytes: 4096,
      storage,
      policy
    }),
    async () => {
      await assert.rejects(
        checkFileMediaUpload(config, session, 4096),
        /allowed 与 reason 不一致/
      )
    }
  )
})

test('HTTP 200 business denial resolves allowed=false and sends only size_bytes', async () => {
  let body: unknown
  await withFetch(async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/saimulti/web/file-media/checkUpload')
    assert.equal(init?.method, 'POST')
    body = JSON.parse(String(init?.body))
    return apiResponse({
      allowed: false,
      reason: '单文件大小超过模块策略上限。',
      size_bytes: 4096,
      storage,
      policy
    })
  }, async () => {
    const result = await checkFileMediaUpload(config, session, 4096)
    assert.equal(result.allowed, false)
    assert.equal(result.reason, '单文件大小超过模块策略上限。')
  })
  assert.deepEqual(body, { size_bytes: 4096 })
})

test('HTTP 503 remains an exception and never becomes a business denial', async () => {
  await withFetch(
    async () => apiResponse(null, 503, 503),
    async () => {
      await assert.rejects(
        checkFileMediaUpload(config, session, 4096),
        (error) => error instanceof WebApiError && error.status === 503 && error.code === 503
      )
    }
  )
})

test('byte display uses BigInt-safe integer arithmetic', () => {
  assert.equal(formatFileMediaByteCount('9007199254740993'), '8 PB')
  assert.equal(formatFileMediaByteCount('9223372036854775807'), '7.99 EB')
  assert.equal(formatFileMediaByteCount('9223372036854775808'), '—')
  assert.equal(formatFileMediaQuotaByteCount('0', true), '无限')
  assert.equal(formatFileMediaUsageRatio(0.125), '12.50%')
  assert.equal(formatFileMediaUsageRatio(null), '—')
})
