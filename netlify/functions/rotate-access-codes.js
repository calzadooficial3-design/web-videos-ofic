import { jsonResponse, methodNotAllowed, readBearerToken, readJsonBody } from './_shared/http.js'
import {
  createFingerprint,
  createServerClients,
  getAccessContext,
  getServerConfiguration,
  isValidAccessCode,
  normalizeAccessCode,
} from './_shared/supabase-server.js'

const ROLES = ['admin', 'operator', 'boss']
const MIN_NEW_CODE_LENGTH = 8

function parseCodes(body) {
  const source = body?.codes && typeof body.codes === 'object' ? body.codes : body
  return Object.fromEntries(
    ROLES.map((role) => [role, normalizeAccessCode(source?.[role])]),
  )
}

function validateCodes(codes) {
  const values = ROLES.map((role) => codes[role])

  if (values.some((code) => !isValidAccessCode(code) || code.length < MIN_NEW_CODE_LENGTH)) {
    return `Cada código nuevo debe tener entre ${MIN_NEW_CODE_LENGTH} y 128 caracteres.`
  }

  if (new Set(values).size !== ROLES.length) {
    return 'Cada rol debe tener un código diferente.'
  }

  return null
}

export default async function rotateAccessCodes(request) {
  if (request.method !== 'POST') {
    return methodNotAllowed()
  }

  try {
    const accessToken = readBearerToken(request)

    if (!accessToken) {
      return jsonResponse({ error: 'Sesión no válida.' }, 401)
    }

    const body = await readJsonBody(request)

    if (!body) {
      return jsonResponse({ error: 'Solicitud no válida.' }, 400)
    }

    const configuration = getServerConfiguration()
    const { publicClient, serviceClient } = createServerClients(configuration)
    const { data: callerData, error: callerError } = await publicClient.auth.getUser(accessToken)
    const caller = callerData?.user

    if (callerError || !caller) {
      return jsonResponse({ error: 'Sesión no válida.' }, 401)
    }

    const accessContext = await getAccessContext(accessToken, configuration)

    if (
      !accessContext
      || accessContext.active !== true
      || accessContext.userId !== caller.id
      || accessContext.role !== 'admin'
    ) {
      return jsonResponse({ error: 'Solo un administrador puede cambiar los códigos.' }, 403)
    }

    const codes = parseCodes(body)
    const validationError = validateCodes(codes)

    if (validationError) {
      return jsonResponse({ error: validationError }, 400)
    }

    const { data: profiles, error: profilesError } = await serviceClient
      .from('profiles')
      .select('user_id, role')
      .eq('organization_id', accessContext.organizationId)
      .eq('active', true)
      .in('role', ROLES)

    if (profilesError) {
      return jsonResponse({ error: 'No se pudieron preparar las cuentas de acceso.' }, 503)
    }

    const profilesByRole = Object.fromEntries(
      ROLES.map((role) => [role, profiles?.filter((profile) => profile.role === role) || []]),
    )

    if (ROLES.some((role) => profilesByRole[role].length !== 1)) {
      return jsonResponse(
        { error: 'Debe existir exactamente una cuenta activa para cada rol.' },
        409,
      )
    }

    const accounts = Object.fromEntries(
      ROLES.map((role) => [role, profilesByRole[role][0]]),
    )

    if (accounts.admin.user_id !== caller.id) {
      return jsonResponse({ error: 'La cuenta administradora no coincide con la sesión.' }, 409)
    }

    const accountUsers = await Promise.all(
      ROLES.map(async (role) => {
        const { data, error } = await serviceClient.auth.admin.getUserById(accounts[role].user_id)
        return error ? null : data?.user || null
      }),
    )

    if (accountUsers.some((user) => !user?.email)) {
      return jsonResponse({ error: 'Una o más cuentas de acceso no están disponibles.' }, 409)
    }

    const fingerprints = Object.fromEntries(
      ROLES.map((role) => [role, createFingerprint(codes[role], configuration.accessCodePepper)]),
    )

    // La migración actual rota las tres huellas en una sola transacción. El
    // fallback conserva compatibilidad mientras una instalación anterior aplica
    // esa migración; cada upsert individual sigue siendo idempotente.
    const atomicPayload = {
      p_organization_id: accessContext.organizationId,
      p_admin_auth_user_id: accounts.admin.user_id,
      p_admin_code_fingerprint: fingerprints.admin,
      p_operator_auth_user_id: accounts.operator.user_id,
      p_operator_code_fingerprint: fingerprints.operator,
      p_boss_auth_user_id: accounts.boss.user_id,
      p_boss_code_fingerprint: fingerprints.boss,
    }
    const { error: atomicRotationError } = await serviceClient.rpc(
      'service_rotate_access_codes',
      atomicPayload,
    )
    const atomicRpcMissing = atomicRotationError && (
      atomicRotationError.code === 'PGRST202'
      || (
        /service_rotate_access_codes/i.test(atomicRotationError.message || '')
        && /not find|does not exist/i.test(atomicRotationError.message || '')
      )
    )

    if (atomicRotationError && !atomicRpcMissing) {
      const status = atomicRotationError.code === '23505' ? 409 : 503
      return jsonResponse({
        error: status === 409
          ? 'Los códigos deben ser distintos y no estar asignados a otra cuenta.'
          : 'No se pudieron actualizar todos los códigos. Vuelve a intentarlo.',
      }, status)
    }

    if (atomicRpcMissing) {
      // El esquema anterior no puede intercambiar huellas únicas dentro de una
      // sola transacción. En ese caso se conserva la validación previa para
      // impedir una rotación parcialmente incompatible.
      const collisionChecks = await Promise.all(
        ROLES.map(async (role) => {
          const { data, error } = await serviceClient.rpc('service_lookup_access_code', {
            p_code_fingerprint: fingerprints[role],
          })
          const row = Array.isArray(data) ? data[0] : data

          if (error) return { error: true }
          if (!row) return { error: false, collision: false }

          const belongsToTarget = (
            row.auth_user_id === accounts[role].user_id
            && row.organization_id === accessContext.organizationId
            && row.role === role
          )

          return { error: false, collision: !belongsToTarget }
        }),
      )

      if (collisionChecks.some((result) => result.error)) {
        return jsonResponse({ error: 'No se pudieron validar los nuevos códigos.' }, 503)
      }

      if (collisionChecks.some((result) => result.collision)) {
        return jsonResponse(
          { error: 'Aplica la migración más reciente antes de intercambiar códigos entre roles.' },
          409,
        )
      }

      const rotationResults = await Promise.all(
        ROLES.map(async (role) => {
          const { error: fingerprintError } = await serviceClient.rpc(
            'service_upsert_access_code',
            {
              p_organization_id: accessContext.organizationId,
              p_role: role,
              p_auth_user_id: accounts[role].user_id,
              p_code_fingerprint: fingerprints[role],
              p_code_hint: null,
            },
          )

          return !fingerprintError
        }),
      )

      if (rotationResults.some((succeeded) => !succeeded)) {
        return jsonResponse(
          { error: 'No se pudieron actualizar todos los códigos. Vuelve a intentarlo.' },
          503,
        )
      }
    }

    // Revocar todos los refresh tokens compartidos de cada rol. Los access
    // tokens ya emitidos expiran según el JWT expiry configurado en Supabase.
    for (let index = 0; index < ROLES.length; index += 1) {
      const { data: linkData, error: linkError } = await serviceClient.auth.admin.generateLink({
        type: 'magiclink',
        email: accountUsers[index].email,
      })
      const tokenHash = linkData?.properties?.hashed_token
      if (linkError || !tokenHash) {
        return jsonResponse({
          error: 'Los códigos se actualizaron, pero no se pudieron cerrar todas las sesiones. Reenvía los mismos códigos.',
        }, 503)
      }

      const { data: sessionData, error: sessionError } = await publicClient.auth.verifyOtp({
        token_hash: tokenHash,
        type: 'email',
      })
      const generatedAccessToken = sessionData?.session?.access_token
      if (sessionError || !generatedAccessToken) {
        return jsonResponse({
          error: 'Los códigos se actualizaron, pero no se pudieron cerrar todas las sesiones. Reenvía los mismos códigos.',
        }, 503)
      }

      const { error: signOutError } = await serviceClient.auth.admin.signOut(
        generatedAccessToken,
        'global',
      )
      if (signOutError) {
        return jsonResponse({
          error: 'Los códigos se actualizaron, pero no se pudieron cerrar todas las sesiones. Reenvía los mismos códigos.',
        }, 503)
      }
    }

    return jsonResponse({ ok: true, rotated_roles: ROLES, reauthenticate: true })
  } catch {
    return jsonResponse({ error: 'El servicio de códigos no está disponible.' }, 500)
  }
}
