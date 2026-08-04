import { jsonResponse, methodNotAllowed, readJsonBody } from './_shared/http.js'
import {
  createFingerprint,
  createServerClients,
  getAccessContext,
  getClientIp,
  getServerConfiguration,
  isValidAccessCode,
  normalizeAccessCode,
  ServerConfigurationError,
} from './_shared/supabase-server.js'

const INVALID_CODE_MESSAGE = 'Código de acceso no válido.'
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60
const MAX_CODE_FAILURES = 8
const MAX_IP_FAILURES = 30

async function recordAttempt(serviceClient, {
  organizationId = null,
  codeFingerprint,
  ipFingerprint,
  succeeded,
}) {
  return serviceClient.rpc('service_record_access_attempt', {
    p_organization_id: organizationId,
    p_code_fingerprint: codeFingerprint,
    p_ip_fingerprint: ipFingerprint,
    p_succeeded: succeeded,
  })
}

async function rejectInvalidCode(serviceClient, attempt) {
  const { error } = await recordAttempt(serviceClient, { ...attempt, succeeded: false })

  if (error) {
    return jsonResponse({ error: 'No se pudo validar el acceso.' }, 503)
  }

  return jsonResponse({ error: INVALID_CODE_MESSAGE }, 401)
}

export default async function loginWithCode(request, context) {
  if (request.method !== 'POST') {
    return methodNotAllowed()
  }

  try {
    const fetchSite = request.headers.get('sec-fetch-site')
    if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
      return jsonResponse({ error: 'Origen no permitido.' }, 403)
    }

    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: 'Solicitud no válida.' }, 400)
    }
    const code = normalizeAccessCode(body?.code)
    const configuration = getServerConfiguration()
    const { publicClient, serviceClient } = createServerClients(configuration)
    const codeFingerprint = createFingerprint(code, configuration.accessCodePepper)
    const ipFingerprint = createFingerprint(
      `ip:${getClientIp(request, context)}`,
      configuration.accessCodePepper,
    )

    const [codeFailuresResult, ipFailuresResult] = await Promise.all([
      serviceClient.rpc('service_count_recent_failures', {
        p_code_fingerprint: codeFingerprint,
        p_ip_fingerprint: null,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      }),
      serviceClient.rpc('service_count_recent_failures', {
        p_code_fingerprint: null,
        p_ip_fingerprint: ipFingerprint,
        p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      }),
    ])

    if (codeFailuresResult.error || ipFailuresResult.error) {
      return jsonResponse({ error: 'No se pudo validar el acceso.' }, 503)
    }

    if (
      Number(codeFailuresResult.data || 0) >= MAX_CODE_FAILURES
      || Number(ipFailuresResult.data || 0) >= MAX_IP_FAILURES
    ) {
      return jsonResponse(
        { error: 'Demasiados intentos. Inténtalo nuevamente más tarde.', retry_after: RATE_LIMIT_WINDOW_SECONDS },
        429,
        { 'retry-after': String(RATE_LIMIT_WINDOW_SECONDS) },
      )
    }

    const baseAttempt = { codeFingerprint, ipFingerprint }

    if (!isValidAccessCode(code)) {
      return rejectInvalidCode(serviceClient, baseAttempt)
    }

    const { data: lookupRows, error: lookupError } = await serviceClient.rpc(
      'service_lookup_access_code',
      { p_code_fingerprint: codeFingerprint },
    )

    if (lookupError) {
      return jsonResponse({ error: 'No se pudo validar el acceso.' }, 503)
    }

    const lookup = Array.isArray(lookupRows) ? lookupRows[0] : lookupRows

    if (!lookup?.auth_user_id || !lookup?.organization_id || !lookup?.role) {
      return rejectInvalidCode(serviceClient, baseAttempt)
    }

    const { data: authUserData, error: authUserError } = await serviceClient.auth.admin.getUserById(
      lookup.auth_user_id,
    )
    const email = authUserData?.user?.email

    if (authUserError || !email) {
      return rejectInvalidCode(serviceClient, {
        ...baseAttempt,
        organizationId: lookup.organization_id,
      })
    }

    const { data: linkData, error: linkError } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
    })
    const tokenHash = linkData?.properties?.hashed_token

    if (linkError || !tokenHash) {
      return rejectInvalidCode(serviceClient, {
        ...baseAttempt,
        organizationId: lookup.organization_id,
      })
    }

    const { data: authData, error: signInError } = await publicClient.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'email',
    })
    const session = authData?.session

    if (signInError || !session?.access_token || !session?.refresh_token || !authData?.user) {
      return rejectInvalidCode(serviceClient, {
        ...baseAttempt,
        organizationId: lookup.organization_id,
      })
    }

    const accessContext = await getAccessContext(session.access_token, configuration)
    const contextMatchesLookup = (
      accessContext?.active === true
      && accessContext.userId === authData.user.id
      && accessContext.userId === lookup.auth_user_id
      && accessContext.organizationId === lookup.organization_id
      && accessContext.role === lookup.role
    )

    if (!contextMatchesLookup) {
      await serviceClient.auth.admin.signOut(session.access_token, 'local')
      return rejectInvalidCode(serviceClient, {
        ...baseAttempt,
        organizationId: lookup.organization_id,
      })
    }

    const { error: recordError } = await recordAttempt(serviceClient, {
      ...baseAttempt,
      organizationId: lookup.organization_id,
      succeeded: true,
    })

    if (recordError) {
      await serviceClient.auth.admin.signOut(session.access_token, 'local')
      return jsonResponse({ error: 'No se pudo completar el acceso.' }, 503)
    }

    return jsonResponse({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at ?? null,
      expires_in: session.expires_in ?? null,
      token_type: session.token_type || 'bearer',
      role: accessContext.role,
      user_id: accessContext.userId,
      organization_id: accessContext.organizationId,
      organization: accessContext.organization,
      display_name: accessContext.displayName || null,
    })
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return jsonResponse({
        error: 'Falta configurar Supabase en Netlify.',
        code: error.code,
        missing_variables: error.missingVariables,
      }, 503)
    }
    return jsonResponse({ error: 'El servicio de acceso no está disponible.' }, 500)
  }
}
