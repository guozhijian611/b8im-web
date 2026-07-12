/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISCOVERY_BASE_URL?: string
  readonly VITE_APP_MODE?: 'domain' | 'enterprise_code'
  readonly VITE_ROUTING_PUBLIC_KEYS?: string
  readonly VITE_APP_INFO_PATH?: string
  readonly VITE_WEB_DEFAULT_NAME?: string
  readonly VITE_WEB_DEFAULT_LOGO_TEXT?: string
  readonly VITE_WEB_DEFAULT_COPYRIGHT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
