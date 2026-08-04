import { createHmac, randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { loadEnv } from 'vite'

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001'
const MANAGED_BY = 'scripts/provision-supabase-roles.mjs'
const ROLES = [
  {
    role: 'admin',
    codeVariable: 'ADMIN_ACCESS_CODE',
    emailVariable: 'ADMIN_AUTH_EMAIL',
    defaultEmail: 'video-hub-admin@accounts.invalid',
    displayName: 'Administrador',
  },
  {
    role: 'operator',
    codeVariable: 'OPERATOR_ACCESS_CODE',
    emailVariable: 'OPERATOR_AUTH_EMAIL',
    defaultEmail: 'video-hub-operator@accounts.invalid',
    displayName: 'Operante',
  },
  {
    role: 'boss',
    codeVariable: 'BOSS_ACCESS_CODE',
    emailVariable: 'BOSS_AUTH_EMAIL',
    defaultEmail: 'video-hub-boss@accounts.invalid',
    displayName: 'Jefe',
  },
]

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
  const configuredAccessCodePepper = (environment.ACCESS_CODE_PEPPER || '').trim()
  const accessCodePepper = configuredAccessCodePepper || secretKey

  const missingVariables = []
  if (!projectUrl) missingVariables.push('SUPABASE_URL o VITE_SUPABASE_URL')
  if (!publishableKey) {
    missingVariables.push('SUPABASE_PUBLISHABLE_KEY o VITE_SUPABASE_PUBLISHABLE_KEY')
  }
  if (!secretKey) missingVariables.push('SUPABASE_SECRET_KEY')

  const accounts = ROLES.map((definition) => {
    const accessCode = normalizeAccessCode(environment[definition.codeVariable])
    const email = (environment[definition.emailVariable] || definition.defaultEmail)
      .trim()
      .toLowerCase()

    if (!accessCode) missingVariables.push(definition.codeVariable)

    return { ...definition, accessCode, email }
  })

  if (missingVariables.length > 0) {
    throw new ProvisioningError(
      `Faltan variables requeridas: ${[...new Set(missingVariables)].join(', ')}`,
    )
  }

  validateConfiguration({ projectUrl, publishableKey, secretKey, accounts })

  return {
    projectUrl,
    publishableKey,
    secretKey,
    accessCodePepper,
    usesLegacyPepper: !configuredAccessCodePepper,
    accounts,
  }
}

function normalizeAccessCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : ''
}

function validateConfiguration({ projectUrl, publishableKey, secretKey, accounts }) {
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

  for (const account of accounts) {
    if (account.accessCode.length < 6 || account.accessCode.length > 128) {
      throw new ProvisioningError(
        `${account.codeVariable} debe tener entre 6 y 128 caracteres.`,
      )
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) {
      throw new ProvisioningError(`${account.emailVariable} no contiene un correo válido.`)
    }
  }

  if (new Set(accounts.map(({ accessCode }) => accessCode)).size !== accounts.length) {
    throw new ProvisioningError('Cada rol debe tener un código de acceso diferente.')
  }

  if (new Set(accounts.map(({ email }) => email)).size !== accounts.length) {
    throw new ProvisioningError('Cada rol debe tener un correo interno diferente.')
  }
}

function fingerprintAccessCode(accessCode, accessCodePepper) {
  return createHmac('sha256', accessCodePepper)
    .update(accessCode, 'utf8')
    .digest('hex')
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
    throw new ProvisioningError(
      `Supabase rechazó la clave publicable (HTTP ${response.status}).`,
    )
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

async function ensureAuthUser(supabase, account) {
  const existingUser = await findUserByEmail(supabase, account.email)
  const internalPassword = randomBytes(32).toString('base64url')
  const userMetadata = {
    ...(existingUser?.user_metadata || {}),
    display_name: account.displayName,
    managed_by: MANAGED_BY,
  }
  const appMetadata = {
    ...(existingUser?.app_metadata || {}),
    video_hub_organization_id: ORGANIZATION_ID,
    video_hub_role: account.role,
  }

  if (existingUser) {
    const { data, error } = await supabase.auth.admin.updateUserById(existingUser.id, {
      password: internalPassword,
      email_confirm: true,
      user_metadata: userMetadata,
      app_metadata: appMetadata,
    })

    if (error || !data?.user) {
      throw new ProvisioningError(
        `No se pudo actualizar la cuenta Auth del rol ${account.role}.`,
        error,
      )
    }

    return { user: data.user, action: 'actualizada' }
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email: account.email,
    password: internalPassword,
    email_confirm: true,
    user_metadata: userMetadata,
    app_metadata: appMetadata,
  })

  if (error || !data?.user) {
    throw new ProvisioningError(
      `No se pudo crear la cuenta Auth del rol ${account.role}.`,
      error,
    )
  }

  return { user: data.user, action: 'creada' }
}

async function upsertProfile(supabase, account, userId) {
  const { error } = await supabase.from('profiles').upsert(
    {
      user_id: userId,
      organization_id: ORGANIZATION_ID,
      role: account.role,
      display_name: account.displayName,
      active: true,
    },
    { onConflict: 'user_id' },
  )

  if (error) {
    throw new ProvisioningError(
      `No se pudo sincronizar el perfil del rol ${account.role}.`,
      error,
    )
  }
}

async function deactivateDuplicateProfiles(supabase, accountsByRole) {
  for (const [role, userId] of Object.entries(accountsByRole)) {
    const { error } = await supabase
      .from('profiles')
      .update({ active: false })
      .eq('organization_id', ORGANIZATION_ID)
      .eq('role', role)
      .eq('active', true)
      .neq('user_id', userId)

    if (error) {
      throw new ProvisioningError(
        `No se pudieron desactivar perfiles duplicados del rol ${role}.`,
        error,
      )
    }
  }
}

async function upsertAccessFingerprint(supabase, account, userId, accessCodePepper) {
  const { error } = await supabase.rpc('service_upsert_access_code', {
    p_organization_id: ORGANIZATION_ID,
    p_role: account.role,
    p_auth_user_id: userId,
    p_code_fingerprint: fingerprintAccessCode(account.accessCode, accessCodePepper),
    p_code_hint: null,
  })

  if (error) {
    throw new ProvisioningError(
      `No se pudo registrar la huella de acceso del rol ${account.role}.`,
      error,
    )
  }
}

async function main() {
  const configuration = readEnvironment()
  const supabase = serviceClient(configuration.projectUrl, configuration.secretKey)

  console.log('Comprobando la configuración de Supabase...')
  if (configuration.usesLegacyPepper) {
    console.warn(
      'ADVERTENCIA · ACCESS_CODE_PEPPER no está configurado; se usa temporalmente SUPABASE_SECRET_KEY.',
    )
  }
  await assertPublicConnection(configuration.projectUrl, configuration.publishableKey)
  await assertOrganizationExists(supabase)

  const provisionedAccounts = []

  for (const account of configuration.accounts) {
    const result = await ensureAuthUser(supabase, account)
    provisionedAccounts.push({ account, userId: result.user.id })
    console.log(`OK · Cuenta ${account.role} ${result.action}`)
  }

  for (const { account, userId } of provisionedAccounts) {
    await upsertProfile(supabase, account, userId)
  }

  await deactivateDuplicateProfiles(
    supabase,
    Object.fromEntries(
      provisionedAccounts.map(({ account, userId }) => [account.role, userId]),
    ),
  )

  for (const { account, userId } of provisionedAccounts) {
    await upsertAccessFingerprint(
      supabase,
      account,
      userId,
      configuration.accessCodePepper,
    )
  }

  console.log('OK · 3 perfiles y 3 huellas de acceso sincronizados')
  console.log('Aprovisionamiento completado sin mostrar códigos ni claves.')
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
