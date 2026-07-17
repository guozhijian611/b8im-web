import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CLIENT_MODULE_REGISTRY,
  availableClientTabbar,
  parseClientConfig
} from '../src/services/clientModuleRegistry.ts'

const keys = Object.keys(CLIENT_MODULE_REGISTRY)

function payload() {
  return {
    version: 13,
    organization: '1',
    deployment_id: 'test',
    features: Object.fromEntries(keys.map((key) => [key, true])),
    modules: Object.values(CLIENT_MODULE_REGISTRY).map((item) => ({
      module_key: item.moduleKey,
      version: '1.0.0',
      available: true,
      capabilities: [item.capability],
      permissions: [item.permission],
      config: {}
    })),
    tabbar: Object.values(CLIENT_MODULE_REGISTRY).map((item) => ({
      module_key: item.moduleKey,
      title: item.title
    }))
  }
}

test('九个 Web 模块均有正式注册并按投影显示', () => {
  assert.deepEqual(keys.sort(), [
    'announcement', 'customer_service', 'favorite', 'file_media', 'i18n',
    'moments', 'robot_single', 'search', 'sticker'
  ])
  const config = parseClientConfig(payload(), { organization: '1', deploymentId: 'test' })
  assert.equal(availableClientTabbar(config).length, 9)
})

test('缺少 feature、capability、permission 或 tabbar 时入口失败关闭', () => {
  for (const field of ['feature', 'capability', 'permission', 'tabbar'] as const) {
    const value = payload()
    if (field === 'feature') delete value.features.favorite
    if (field === 'capability') value.modules.find((item) => item.module_key === 'favorite')!.capabilities = []
    if (field === 'permission') value.modules.find((item) => item.module_key === 'favorite')!.permissions = []
    if (field === 'tabbar') value.tabbar = value.tabbar.filter((item) => item.module_key !== 'favorite')
    const config = parseClientConfig(value, { organization: '1', deploymentId: 'test' })
    assert.equal(availableClientTabbar(config).some((item) => item.moduleKey === 'favorite'), false, field)
  }
})
