const BASE_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
  expires: '0',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders,
    },
  })
}

export function methodNotAllowed(allowed = 'POST') {
  return jsonResponse(
    { error: 'Método no permitido.' },
    405,
    { allow: allowed },
  )
}

export async function readJsonBody(request) {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return null
  }

  try {
    return await request.json()
  } catch {
    return null
  }
}

export function readBearerToken(request) {
  const authorization = request.headers.get('authorization') || ''
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1] || null
}
