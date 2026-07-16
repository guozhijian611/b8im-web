import type { TenantBrandConfig } from './tenantConfig.ts'
import { activeServiceCandidate, promoteServiceCandidate } from './routing.ts'
import {
  injectTraceHeaders,
  tryStartTelemetrySpan,
  type TraceContext
} from './telemetry.ts'

interface ApiResponse<T> {
  code?: number
  message?: string
  data?: T
}

export interface WebApiOptions {
  method?: 'GET' | 'POST'
  body?: Record<string, unknown> | FormData
  token?: string
  /** Customer-service external visitor guest token (sent as X-CS-Guest-Token). */
  guestToken?: string
  query?: Record<string, string | number | undefined>
  traceContext?: TraceContext
}

export interface WebApiUploadOptions {
  body: FormData
  token?: string
  query?: WebApiOptions['query']
  onProgress?: (progress: number) => void
  traceContext?: TraceContext
}

export class WebApiError extends Error {
  readonly status: number
  readonly code?: number

  constructor(message: string, status: number, code?: number) {
    super(message)
    this.name = 'WebApiError'
    this.status = status
    this.code = code
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
  const method = options.method ?? 'GET'
  const requestSpan = tryStartTelemetrySpan({
    name: 'web.http.request',
    kind: 'client',
    parent: options.traceContext,
    fields: {
      organization: config.organization,
      method,
      path
    }
  })
  const headers = new Headers({
    Accept: 'application/json',
    'App-Id': config.organization
  })
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`)
  if (options.guestToken) headers.set('X-CS-Guest-Token', options.guestToken)

  const init: RequestInit = {
    method,
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

  const safeToRetry = method === 'GET'
  const attempts = safeToRetry ? config.serverInfo.routes.length : 1
  let lastNetworkError: unknown
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const candidate = activeServiceCandidate(config, 'api')
    const attemptSpan = tryStartTelemetrySpan({
      name: 'web.http.attempt',
      kind: 'client',
      parent: requestSpan?.context ?? options.traceContext,
      fields: {
        organization: config.organization,
        method,
        path,
        routeId: candidate.routeId,
        retryCount: attempt
      }
    })
    if (attemptSpan) injectTraceHeaders(headers, attemptSpan.context)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    init.signal = controller.signal
    let response: Response
    try {
      response = await fetch(createWebApiUrl(config, path, options.query, candidate.url), init)
    } catch (error) {
      lastNetworkError = error
      const aborted = controller.signal.aborted
      attemptSpan?.fail({
        code: aborted ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK_ERROR',
        type: aborted ? 'timeout' : 'network_error',
        retryCount: attempt
      })
      if (!safeToRetry || attempt + 1 >= attempts) {
        requestSpan?.fail({
          code: aborted ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK_ERROR',
          type: aborted ? 'timeout' : 'network_error',
          retryCount: attempt
        })
        if (aborted) throw new WebApiError('请求超时，请检查目标服务', 0)
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
      attemptSpan?.fail({
        code: 'HTTP_RETRYABLE_STATUS',
        type: 'upstream_unavailable',
        retryCount: attempt
      }, { statusCode: response.status })
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
      const code = Number.isSafeInteger(payload.code) ? `API_${payload.code}` : 'HTTP_RESPONSE_ERROR'
      attemptSpan?.fail({
        code,
        type: 'api_error',
        retryCount: attempt
      }, { statusCode: response.status })
      requestSpan?.fail({
        code,
        type: 'api_error',
        retryCount: attempt
      }, { statusCode: response.status })
      throw new WebApiError(
        payload.message || `请求失败：${response.status}`,
        response.status,
        payload.code
      )
    }
    attemptSpan?.end({ statusCode: response.status, retryCount: attempt })
    requestSpan?.end({ statusCode: response.status, retryCount: attempt })
    return payload.data as T
  }
  requestSpan?.fail({
    code: 'HTTP_NO_AVAILABLE_ROUTE',
    type: 'network_error'
  })
  throw lastNetworkError ?? new WebApiError('没有可用的 API 线路', 0)
}

export function requestWebApiWithUpload<T>(
  config: TenantBrandConfig,
  path: string,
  options: WebApiUploadOptions
): Promise<T> {
  return new Promise((resolve, reject) => {
    const uploadSpan = tryStartTelemetrySpan({
      name: 'web.http.upload',
      kind: 'client',
      parent: options.traceContext,
      fields: {
        organization: config.organization,
        method: 'POST',
        path
      }
    })
    const xhr = new XMLHttpRequest()
    xhr.open('POST', createWebApiUrl(config, path, options.query), true)
    xhr.withCredentials = false
    xhr.timeout = API_TIMEOUT_MS
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('App-Id', config.organization)
    if (options.token) xhr.setRequestHeader('Authorization', `Bearer ${options.token}`)
    if (uploadSpan) {
      xhr.setRequestHeader('traceparent', uploadSpan.context.traceparent)
      if (uploadSpan.context.tracestate) {
        xhr.setRequestHeader('tracestate', uploadSpan.context.tracestate)
      }
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !options.onProgress) return
      options.onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onerror = () => {
      uploadSpan?.fail({ code: 'HTTP_UPLOAD_NETWORK_ERROR', type: 'network_error' }, { statusCode: xhr.status })
      reject(new WebApiError('上传失败，请检查网络后重试', xhr.status))
    }
    xhr.ontimeout = () => {
      uploadSpan?.fail({ code: 'HTTP_UPLOAD_TIMEOUT', type: 'timeout' }, { statusCode: xhr.status })
      reject(new WebApiError('上传超时，请检查目标服务', xhr.status))
    }
    xhr.onload = () => {
      let payload: ApiResponse<T> = {}
      try {
        payload = JSON.parse(xhr.responseText || '{}') as ApiResponse<T>
      } catch {
        payload = {}
      }
      if (xhr.status < 200 || xhr.status >= 300 || payload.code !== 200) {
        uploadSpan?.fail({
          code: Number.isSafeInteger(payload.code) ? `API_${payload.code}` : 'HTTP_UPLOAD_RESPONSE_ERROR',
          type: 'api_error'
        }, { statusCode: xhr.status })
        reject(new WebApiError(payload.message || `请求失败：${xhr.status}`, xhr.status, payload.code))
        return
      }
      uploadSpan?.end({ statusCode: xhr.status })
      resolve(payload.data as T)
    }
    xhr.send(options.body)
  })
}
