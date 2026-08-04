import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const AUTH_OPTIONS = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
}

export class ServerConfigurationError extends Error {
  constructor(missingVariables = []) {
    super(`Server configuration is incomplete: ${missingVariables.join(', ')}`)
    this.name = 'ServerConfigurationError'
    this.code = 'SERVER_CONFIGURATION_MISSING'
    this.missingVariables = [...missingVariables]
  }
}

export function getServerConfiguration() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  const secretKey = process.env.SUPABASE_SECRET_KEY
  const accessCodePepper = process.env.ACCESS_CODE_PEPPER || secretKey

  const missingVariables = []
  if (!url) missingVariables.push('VITE_SUPABASE_URL')
  if (!publishableKey) missingVariables.push('VITE_SUPABASE_PUBLISHABLE_KEY')
  if (!secretKey) missingVariables.push('SUPABASE_SECRET_KEY')
  if (!accessCodePepper && !missingVariables.includes('SUPABASE_SECRET_KEY')) {
    missingVariables.push('ACCESS_CODE_PEPPER')
  }
  if (missingVariables.length) throw new ServerConfigurationError(missingVariables)

  return { url, publishableKey, secretKey, accessCodePepper }
}

export function createServerClients(configuration = getServerConfiguration()) {
  const { url, publishableKey, secretKey } = configuration

  return {
    publicClient: createClient(url, publishableKey, { auth: AUTH_OPTIONS }),
    serviceClient: createClient(url, secretKey, { auth: AUTH_OPTIONS }),
  }
}

export function createUserClient(accessToken, configuration = getServerConfiguration()) {
  return createClient(configuration.url, configuration.publishableKey, {
    auth: AUTH_OPTIONS,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  })
}

export function normalizeAccessCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

export function isValidAccessCode(value) {
  return value.length >= 6 && value.length <= 128
}

export function createFingerprint(value, accessCodePepper) {
  return createHmac('sha256', accessCodePepper).update(value, 'utf8').digest('hex')
}

export function getClientIp(request, context) {
  const forwarded = request.headers.get('x-forwarded-for')

  return (
    context?.ip
    || request.headers.get('x-nf-client-connection-ip')
    || forwarded?.split(',')[0]?.trim()
    || request.headers.get('client-ip')
    || 'unknown'
  )
}

export async function getAccessContext(accessToken, configuration) {
  const userClient = createUserClient(accessToken, configuration)
  const { data, error } = await userClient.rpc('get_my_access_context')

  if (error || !data || typeof data !== 'object') {
    return null
  }

  return data
}
