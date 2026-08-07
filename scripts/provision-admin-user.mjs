import { createClient } from '@supabase/supabase-js'
import { loadEnv } from 'vite'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const MANAGED_BY = 'scripts/provision-admin-user.mjs'
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/
const DISPLAY_NAME = 'Administrador'

const AUTH_OPTIONS = {
  autoRefreshToken: false,
  detectSessionInUrl: false,
  persistSession: false,
}

class ProvisioningError extends Error {
  constructor(message, cause) {
    super(message, { cause })
    this.name = 'ProvisioningError'
  }
}

function readEnvironment() {
  const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const fileEnvironment = loadEnv(mode, process.cwd(), '')
  const environment = { ...fileEnvironment, ...process.env }

  const projectUrl = (
    environment.SUPABASE_URL || environment.VITE_SUPABASE_URL || ''
  ).trim().replace(/\/$/, '')
  const publishableKey = (
    environment.SUPABASE_PUBLISHABLE_KEY
    || environment.VITE_SUPABASE_PUBLISHABLE_KEY
    || ''
  ).trim()
  const secretKey = (environment.SUPABASE_SECRET_KEY || '').trim()
  const username = (environment.ADMIN_USERNAME || '').trim().toLowerCase()
  const password = environment.ADMIN_PASSWORD || ''
  const email = (environment.ADMIN_AUTH_EMAIL || 'video-hub-admin@accounts.invalid').trim().toLowerCase()

  const missingVariables = []
  if (!projectUrl) missingVariables.push('SUPABASE_URL o VITE_SUPABASE_URL')
  if (!publishableKey) missingVariables.push('SUPABASE_PUBLISHABLE_KEY o VITE_SUPABASE_PUBLISHABLE_KEY')
  if (!secretKey) missingVariables.push('SUPABASE_SECRET_KEY')
  if (!username) missingVariables.push('ADMIN_USERNAME')
  if (!password) missingVariables.push('ADMIN_PASSWORD')

  if (missingVariables.length > 0) {
    throw new ProvisioningError(
      `Faltan variables requeridas: ${[...new Set(missingVariables)].join(', ')}`,
    )
  }

  validateConfiguration({ projectUrl, publishableKey, secretKey, username, password })

  return { projectUrl, publishableKey, secretKey, username, password, email }
}

function validateConfiguration({ projectUrl, publishableKey, secretKey, username, password }) {
  let parsedUrl

  try {
    parsedUrl = new URL(projectUrl)
  } catch {
    throw new ProvisioningError('La URL de Supabase no es válida.')
  }

  if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('.supabase.co')) {
    throw new ProvisioningError('La URL debe ser un proyecto HTTPS de Supabase.')
  }

  if (publishableKey === secretKey) {
    throw new ProvisioningError('La clave publicable y la clave secreta no pueden ser iguales.')
  }

  if (!USERNAME_PATTERN.test(username)) {
    throw new ProvisioningError('ADMIN_USERNAME debe tener entre 3 y 32 caracteres (minúsculas, números, puntos o guiones).')
  }

  if (password.length < 8 || password.length > 128) {
    throw new ProvisioningError('ADMIN_PASSWORD debe tener entre 8 y 128 caracteres.')
  }
}

function serviceClient(projectUrl, secretKey) {
  return createClient(projectUrl, secretKey, { auth: AUTH_OPTIONS })
}

async function assertPublicConnection(projectUrl, publishableKey) {
  let response

  try {
    response = await fetch(`${projectUrl}/auth/v1/settings`, {
      headers: { apikey: publishableKey },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new ProvisioningError('No se pudo conectar con Supabase.', error)
  }

  if (!response.ok) {
    throw new ProvisioningError(`Supabase rechazó la clave publicable (HTTP ${response.status}).`)
  }
}

async function assertOrganizationExists(supabase) {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, active')
    .eq('id', ORGANIZATION_ID)
    .maybeSingle()

  if (error) {
    throw new ProvisioningError(
      'No se pudo comprobar la organización. Verifica que la migración esté aplicada.',
      error,
    )
  }

  if (!data) {
    throw new ProvisioningError(
      'La organización inicial no existe. Ejecuta supabase/seed.sql antes de aprovisionar.',
    )
  }

  if (!data.active) {
    throw new ProvisioningError('La organización inicial está inactiva.')
  }
}

async function findUserByEmail(supabase, email) {
  const perPage = 1000

  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })

    if (error) {
      throw new ProvisioningError('No se pudieron consultar los usuarios de Auth.', error)
    }

    const users = data?.users || []
    const match = users.find((user) => user.email?.toLowerCase() === email)

    if (match) return match
    if (users.length < perPage) return null
  }

  throw new ProvisioningError('La búsqueda de usuarios de Auth excedió el límite seguro.')
}

async function ensureAuthUser(supabase, { email, password }) {
  const existingUser = await findUserByEmail(supabase, email)
  const userMetadata = { display_name: DISPLAY_NAME, managed_by: MANAGED_BY }
  const appMetadata = { video_hub_organization_id: ORGANIZATION_ID, video_hub_role: 'admin' }

  if (existingUser) {
    const { data, error } = await supabase.auth.admin.updateUserById(existingUser.id, {
      password,
      email_confirm: true,
      user_metadata: { ...(existingUser.user_metadata || {}), ...userMetadata },
      app_metadata: { ...(existingUser.app_metadata || {}), ...appMetadata },
    })

    if (error || !data?.user) {
      throw new ProvisioningError('No se pudo actualizar la cuenta Auth del administrador.', error)
    }

    return { user: data.user, action: 'actualizada' }
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: userMetadata,
    app_metadata: appMetadata,
  })

  if (error || !data?.user) {
    throw new ProvisioningError('No se pudo crear la cuenta Auth del administrador.', error)
  }

  return { user: data.user, action: 'creada' }
}

async function upsertProfile(supabase, { username, userId }) {
  const { error } = await supabase.from('profiles').upsert(
    {
      user_id: userId,
      organization_id: ORGANIZATION_ID,
      role: 'admin',
      display_name: DISPLAY_NAME,
      username,
      active: true,
    },
    { onConflict: 'user_id' },
  )

  if (error) {
    throw new ProvisioningError('No se pudo sincronizar el perfil del administrador.', error)
  }
}

async function main() {
  const configuration = readEnvironment()
  const supabase = serviceClient(configuration.projectUrl, configuration.secretKey)

  console.log('Comprobando la configuración de Supabase...')
  await assertPublicConnection(configuration.projectUrl, configuration.publishableKey)
  await assertOrganizationExists(supabase)

  const { user, action } = await ensureAuthUser(supabase, configuration)
  console.log(`OK · Cuenta admin ${action}`)

  await upsertProfile(supabase, { username: configuration.username, userId: user.id })

  console.log(`OK · Perfil admin sincronizado con el usuario "${configuration.username}"`)
  console.log('Aprovisionamiento completado sin mostrar la contraseña.')
}

try {
  await main()
} catch (error) {
  const message = error instanceof ProvisioningError
    ? error.message
    : 'El aprovisionamiento falló de forma inesperada.'

  console.error(`ERROR · ${message}`)
  process.exitCode = 1
}
