import type { TenantBrandConfig } from './tenantConfig'
import { activeServiceCandidate, promoteServiceCandidate } from './routing'

interface ApiResponse<T> {
  code?: number
  message?: string
  data?: T
}

export interface WebApiOptions {
  method?: 'GET' | 'POST'
  body?: Record<string, unknown> | FormData
  token?: string
  query?: Record<string, string | number | undefined>
}

export interface WebApiUploadOptions {
  body: FormData
  token?: string
  query?: WebApiOptions['query']
  onProgress?: (progress: number) => void
}

export class WebApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number
  ) {
    super(message)
    this.name = 'WebApiError'
  }
}

const API_TIMEOUT_MS = 15000

function assertApiContext(config: TenantBrandConfig) {
  if (!config.discovered || !config.organization || !config.serverInfo.apiServerUrl) {
    throw new Error('尚未建立有效的租户 API 上下文')
  }
}

export function createWebApiUrl(
  config: TenantBrandConfig,
  path: string,
  query?: WebApiOptions['query'],
  baseUrl = activeServiceCandidate(config, 'api').url
) {
  assertApiContext(config)
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('API 路径必须是站内绝对路径')
  }

  const url = new URL(`${baseUrl}${path}`)
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && String(value).trim() !== '') {
        url.searchParams.set(key, String(value))
      }
    })
  }
  return url.toString()
}

async function readPayload<T>(response: Response): Promise<ApiResponse<T>> {
  return (await response.json().catch(() => ({}))) as ApiResponse<T>
}

export async function requestWebApi<T>(
  config: TenantBrandConfig,
  path: string,
  options: WebApiOptions = {}
): Promise<T> {
  const headers = new Headers({
    Accept: 'application/json',
    'App-Id': config.organization
  })
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`)

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'strict-origin-when-cross-origin'
  }
  if (options.body instanceof FormData) {
    init.body = options.body
  } else if (options.body) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(options.body)
  }

  const safeToRetry = (options.method ?? 'GET') === 'GET'
  const attempts = safeToRetry ? config.serverInfo.routes.length : 1
  let lastNetworkError: unknown
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const candidate = activeServiceCandidate(config, 'api')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    init.signal = controller.signal
    let response: Response
    try {
      response = await fetch(createWebApiUrl(config, path, options.query, candidate.url), init)
    } catch (error) {
      lastNetworkError = error
      if (!safeToRetry || attempt + 1 >= attempts) {
        if (controller.signal.aborted) throw new WebApiError('请求超时，请检查目标服务', 0)
        throw error
      }
      const next = promoteServiceCandidate(config, 'api', candidate.routeId)
      console.warn('[b8im:routing] API 线路网络失败，切换备用线路', {
        failedRouteId: candidate.routeId,
        nextRouteId: next.routeId
      })
      continue
    } finally {
      window.clearTimeout(timeout)
    }
    if (safeToRetry && [502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
      const next = promoteServiceCandidate(config, 'api', candidate.routeId)
      console.warn('[b8im:routing] API 线路暂不可用，切换备用线路', {
        failedRouteId: candidate.routeId,
        nextRouteId: next.routeId,
        status: response.status
      })
      continue
    }
    const payload = await readPayload<T>(response)
    if (!response.ok || payload.code !== 200) {
      throw new WebApiError(
        payload.message || `请求失败：${response.status}`,
        response.status,
        payload.code
      )
    }
    return payload.data as T
  }
  throw lastNetworkError ?? new WebApiError('没有可用的 API 线路', 0)
}

export function requestWebApiWithUpload<T>(
  config: TenantBrandConfig,
  path: string,
  options: WebApiUploadOptions
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', createWebApiUrl(config, path, options.query), true)
    xhr.withCredentials = false
    xhr.timeout = API_TIMEOUT_MS
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('App-Id', config.organization)
    if (options.token) xhr.setRequestHeader('Authorization', `Bearer ${options.token}`)

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !options.onProgress) return
      options.onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onerror = () => reject(new WebApiError('上传失败，请检查网络后重试', xhr.status))
    xhr.ontimeout = () => reject(new WebApiError('上传超时，请检查目标服务', xhr.status))
    xhr.onload = () => {
      let payload: ApiResponse<T> = {}
      try {
        payload = JSON.parse(xhr.responseText || '{}') as ApiResponse<T>
      } catch {
        payload = {}
      }
      if (xhr.status < 200 || xhr.status >= 300 || payload.code !== 200) {
        reject(new WebApiError(payload.message || `请求失败：${xhr.status}`, xhr.status, payload.code))
        return
      }
      resolve(payload.data as T)
    }
    xhr.send(options.body)
  })
}
