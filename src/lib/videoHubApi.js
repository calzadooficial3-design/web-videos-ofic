import { getVideoSource } from '../videoUtils'
import { isSupabaseConfigured, supabase } from './supabase'

const VIEWER_ROLES = ['operator', 'boss']
const DATABASE_PROVIDERS = new Set([
  'youtube',
  'google_drive',
  'vimeo',
  'loom',
  'direct',
  'supabase_storage',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ID_BATCH_SIZE = 100
const STORAGE_SIGNED_URL_TTL_SECONDS = 60 * 60
const STORAGE_SIGNED_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000
const LOGIN_FUNCTION_URL = '/.netlify/functions/login-with-code'
const ROTATE_CODES_FUNCTION_URL = '/.netlify/functions/rotate-access-codes'
const SAVE_SNAPSHOT_FUNCTION_URL = '/.netlify/functions/save-admin-snapshot'

export class VideoHubApiError extends Error {
  constructor(message, { code = '', details = '', cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'VideoHubApiError'
    this.code = code
    this.details = details
  }
}

function getClient() {
  if (!isSupabaseConfigured || !supabase) {
    throw new VideoHubApiError(
      'Supabase no está configurado. Define VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.',
      { code: 'SUPABASE_NOT_CONFIGURED' },
    )
  }
  return supabase
}

function throwDatabaseError(error, operation) {
  if (!error) return
  throw new VideoHubApiError(`${operation}: ${error.message}`, {
    code: error.code || 'SUPABASE_ERROR',
    details: error.details || error.hint || '',
    cause: error,
  })
}

function chunk(values, size = ID_BATCH_SIZE) {
  const chunks = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''))
}

function createUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()

  const bytes = new Uint8Array(16)
  if (!globalThis.crypto?.getRandomValues) {
    throw new VideoHubApiError('Este navegador no puede generar identificadores seguros.', {
      code: 'CRYPTO_UNAVAILABLE',
    })
  }
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'seccion'
}

function parseDurationSeconds(label) {
  const pieces = String(label || '').trim().split(':').map(Number)
  if (!pieces.length || pieces.some((piece) => !Number.isInteger(piece) || piece < 0)) return null
  if (pieces.length === 2 && pieces[1] < 60) return pieces[0] * 60 + pieces[1]
  if (pieces.length === 3 && pieces[1] < 60 && pieces[2] < 60) {
    return pieces[0] * 3600 + pieces[1] * 60 + pieces[2]
  }
  return null
}

function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return 'Video'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

function normalizeCodes(codes) {
  return {
    admin: codes?.admin || '',
    operator: codes?.operator || '',
    boss: codes?.boss || '',
  }
}

function mapSettings(row) {
  if (!row) return null
  return {
    productName: row.product_name,
    welcomeTitle: row.welcome_title,
    welcomeMessage: row.welcome_message,
    supportMessage: row.support_message,
    allowLightMode: row.allow_light_mode,
  }
}

async function requestFunction(url, { body, accessToken } = {}) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body || {}),
    })
  } catch (cause) {
    throw new VideoHubApiError('No se pudo conectar con el servicio de acceso.', {
      code: 'FUNCTION_UNREACHABLE',
      cause,
    })
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new VideoHubApiError(payload.error || 'El servicio no pudo completar la solicitud.', {
      code: payload.code || `FUNCTION_HTTP_${response.status}`,
      details: payload.retry_after ? String(payload.retry_after) : '',
    })
  }
  return payload
}

async function selectRowsByIds(table, idColumn, ids, columns = '*') {
  if (!ids.length) return []
  const client = getClient()
  const results = await Promise.all(
    chunk(ids).map((batch) => client.from(table).select(columns).in(idColumn, batch)),
  )
  return results.flatMap((result) => {
    throwDatabaseError(result.error, `No se pudo leer ${table}`)
    return result.data || []
  })
}

async function deleteRowsByIds(table, idColumn, ids, filters = {}) {
  if (!ids.length) return
  const client = getClient()
  for (const batch of chunk(ids)) {
    let query = client.from(table).delete().in(idColumn, batch)
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
    const { error } = await query
    throwDatabaseError(error, `No se pudo eliminar registros de ${table}`)
  }
}

async function archiveRowsByIds(table, idColumn, ids, filters = {}) {
  if (!ids.length) return
  const client = getClient()
  for (const batch of chunk(ids)) {
    let query = client.from(table).update({ active: false }).in(idColumn, batch)
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
    const { error } = await query
    throwDatabaseError(error, `No se pudo archivar registros de ${table}`)
  }
}

async function resolveSourceUrl(source, previousVideo = null) {
  if (!source) return { url: '', expiresAt: null }
  if (source.provider !== 'supabase_storage') {
    return { url: source.source_url || '', expiresAt: null }
  }
  if (!source.storage_bucket || !source.storage_object_path) {
    return { url: '', expiresAt: null }
  }

  const previousSource = previousVideo?.source
  const previousExpiry = Date.parse(previousSource?.signedUrlExpiresAt || '')
  if (
    previousSource?.provider === 'supabase_storage'
    && previousSource.storageBucket === source.storage_bucket
    && previousSource.storageObjectPath === source.storage_object_path
    && previousVideo.url
    && previousExpiry > Date.now() + STORAGE_SIGNED_URL_REFRESH_MARGIN_MS
  ) {
    return { url: previousVideo.url, expiresAt: previousSource.signedUrlExpiresAt }
  }

  const { data, error } = await getClient()
    .storage
    .from(source.storage_bucket)
    .createSignedUrl(source.storage_object_path, STORAGE_SIGNED_URL_TTL_SECONDS)

  // Mantener visible la tarjeta aunque Storage no pueda crear la URL temporal.
  if (error || !data?.signedUrl) return { url: '', expiresAt: null }
  return {
    url: data.signedUrl,
    expiresAt: new Date(Date.now() + STORAGE_SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  }
}

export async function getCurrentSession() {
  const { data, error } = await getClient().auth.getSession()
  throwDatabaseError(error, 'No se pudo recuperar la sesión')
  return data.session || null
}

export async function establishSession(tokens) {
  const accessToken = tokens?.access_token || tokens?.accessToken
  const refreshToken = tokens?.refresh_token || tokens?.refreshToken
  if (!accessToken || !refreshToken) {
    throw new VideoHubApiError('La respuesta de acceso no contiene una sesión válida.', {
      code: 'INVALID_SESSION_TOKENS',
    })
  }

  const { data, error } = await getClient().auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  throwDatabaseError(error, 'No se pudo establecer la sesión')
  return data.session || null
}

export async function loginWithAccessCode(code) {
  const normalizedCode = String(code || '').trim().toUpperCase()
  if (!normalizedCode) {
    throw new VideoHubApiError('Ingresa un código de acceso.', {
      code: 'EMPTY_ACCESS_CODE',
    })
  }

  const payload = await requestFunction(LOGIN_FUNCTION_URL, {
    body: { code: normalizedCode },
  })
  const session = await establishSession(payload)
  const context = await getCurrentAccessContext()

  if (
    (payload.role && payload.role !== context.role)
    || (payload.organization_id && payload.organization_id !== context.organizationId)
    || (payload.user_id && payload.user_id !== context.userId)
  ) {
    await signOut()
    throw new VideoHubApiError('La sesión recibida no coincide con el perfil autorizado.', {
      code: 'SESSION_CONTEXT_MISMATCH',
    })
  }

  return { session, context }
}

// Alias corto para los consumidores que ya usan el nombre del formulario.
export const loginWithCode = loginWithAccessCode

export async function rotateAccessCodes(codes) {
  const session = await getCurrentSession()
  if (!session?.access_token) {
    throw new VideoHubApiError('La sesión administrativa ya no es válida.', {
      code: 'SESSION_REQUIRED',
    })
  }

  return requestFunction(ROTATE_CODES_FUNCTION_URL, {
    body: { codes: normalizeCodes(codes) },
    accessToken: session.access_token,
  })
}

export function onAuthStateChange(callback) {
  const { data } = getClient().auth.onAuthStateChange((event, session) => callback(event, session))
  return () => data.subscription.unsubscribe()
}

export async function signOut(options = {}) {
  const { error } = await getClient().auth.signOut({ scope: options.scope || 'local' })
  throwDatabaseError(error, 'No se pudo cerrar la sesión')
}

export async function getCurrentAccessContext() {
  const { data, error } = await getClient().rpc('get_my_access_context')
  throwDatabaseError(error, 'No se pudo obtener el perfil de acceso')

  if (!data?.userId || !data?.organizationId || !data?.role) {
    throw new VideoHubApiError('La sesión no tiene un perfil activo asociado.', {
      code: 'PROFILE_NOT_FOUND',
    })
  }

  return {
    userId: data.userId,
    organizationId: data.organizationId,
    organization: data.organization || '',
    role: data.role,
    displayName: data.displayName || '',
    active: Boolean(data.active),
    contentRevision: Number.isSafeInteger(Number(data.contentRevision))
      ? Number(data.contentRevision)
      : 0,
  }
}

/**
 * Carga una vista completa desde Supabase. Las políticas RLS determinan qué
 * secciones, tarjetas, asignaciones y enlaces recibe cada rol.
 */
export async function loadVideoHubSnapshot(options = {}) {
  const client = getClient()
  const context = options.context || await getCurrentAccessContext()
  const organizationId = context.organizationId
  const previousVideoById = new Map(
    (options.previousSnapshot?.videos || []).map((video) => [video.id, video]),
  )

  const [organizationResult, settingsResult, sectionsResult, rolesResult, videosResult, assignmentsResult] = await Promise.all([
    client.from('organizations').select('id,name,slug,logo_url').eq('id', organizationId).single(),
    client.from('app_settings').select('product_name,welcome_title,welcome_message,support_message,allow_light_mode').eq('organization_id', organizationId).maybeSingle(),
    client.from('sections').select('id,name,slug,icon,sort_order,created_at').eq('organization_id', organizationId).eq('active', true).order('sort_order'),
    client.from('section_roles').select('section_id,role,visible').eq('organization_id', organizationId),
    client.from('videos').select('id,title,description,duration_label,duration_seconds,featured,created_at').eq('organization_id', organizationId).eq('active', true).order('created_at', { ascending: false }),
    client.from('video_assignments').select('video_id,role,section_id,visible,is_locked,sort_order').eq('organization_id', organizationId),
  ])

  throwDatabaseError(organizationResult.error, 'No se pudo leer la organización')
  throwDatabaseError(settingsResult.error, 'No se pudo leer la configuración')
  throwDatabaseError(sectionsResult.error, 'No se pudieron leer las secciones')
  throwDatabaseError(rolesResult.error, 'No se pudieron leer los permisos de secciones')
  throwDatabaseError(videosResult.error, 'No se pudieron leer los videos')
  throwDatabaseError(assignmentsResult.error, 'No se pudieron leer los permisos de videos')

  const sectionRows = sectionsResult.data || []
  const videoRows = videosResult.data || []
  const sectionIds = new Set(sectionRows.map((section) => section.id))
  const videoIds = new Set(videoRows.map((video) => video.id))
  const roleRows = (rolesResult.data || []).filter((row) => sectionIds.has(row.section_id))
  const assignmentRows = (assignmentsResult.data || []).filter(
    (row) => videoIds.has(row.video_id) && sectionIds.has(row.section_id),
  )
  const sourceRows = await selectRowsByIds(
    'video_sources',
    'video_id',
    [...videoIds],
    'video_id,provider,source_ref,source_url,thumbnail_url,storage_bucket,storage_object_path,metadata',
  )
  const sourceByVideo = new Map(sourceRows.map((source) => [source.video_id, source]))
  const resolvedSourceEntries = await Promise.all(
    sourceRows.map(async (source) => [
      source.video_id,
      await resolveSourceUrl(source, previousVideoById.get(source.video_id)),
    ]),
  )
  const resolvedUrlByVideo = new Map(resolvedSourceEntries)

  const sections = sectionRows.map((section) => ({
    id: section.id,
    name: section.name,
    slug: section.slug,
    icon: section.icon,
    roles: roleRows
      .filter((row) => row.section_id === section.id && row.visible && VIEWER_ROLES.includes(row.role))
      .map((row) => row.role),
    order: section.sort_order,
    createdAt: section.created_at,
  }))

  const videos = videoRows.map((video) => {
    const assignments = {}
    const locked = {}
    assignmentRows
      .filter((row) => row.video_id === video.id && row.visible && VIEWER_ROLES.includes(row.role))
      .forEach((row) => {
        assignments[row.role] = row.section_id
        locked[row.role] = Boolean(row.is_locked)
      })

    const source = sourceByVideo.get(video.id)
    const resolvedSource = resolvedUrlByVideo.get(video.id) || { url: '', expiresAt: null }
    const resolvedUrl = resolvedSource.url
    return {
      id: video.id,
      title: video.title,
      description: video.description || '',
      url: resolvedUrl,
      thumbnailUrl: source?.thumbnail_url || '',
      duration: video.duration_label || formatDuration(video.duration_seconds),
      assignments,
      locked,
      featured: Boolean(video.featured),
      createdAt: video.created_at,
      source: source ? {
        provider: source.provider,
        sourceRef: source.source_ref,
        sourceUrl: source.source_url || '',
        resolvedUrl,
        thumbnailUrl: source.thumbnail_url || '',
        storageBucket: source.storage_bucket || '',
        storageObjectPath: source.storage_object_path || '',
        signedUrlExpiresAt: resolvedSource.expiresAt,
        metadata: source.metadata || {},
      } : null,
    }
  })

  return {
    organization: organizationResult.data?.name || context.organization || '',
    organizationId,
    revision: Number.isSafeInteger(Number(context.contentRevision))
      ? Number(context.contentRevision)
      : 0,
    logoUrl: organizationResult.data?.logo_url || '',
    settings: mapSettings(settingsResult.data),
    sections,
    videos,
    // Los códigos nunca se leen de Supabase: allí solo existen sus huellas.
    codes: normalizeCodes(options.codes),
    context,
  }
}

function prepareSnapshot(snapshot, organizationId, existingSections) {
  if (!Array.isArray(snapshot?.sections) || !Array.isArray(snapshot?.videos)) {
    throw new VideoHubApiError('El snapshot debe incluir listas de secciones y videos.', {
      code: 'INVALID_SNAPSHOT',
    })
  }

  const existingSectionById = new Map(existingSections.map((section) => [section.id, section]))
  const existingSlugOwner = new Map(existingSections.map((section) => [section.slug, section.id]))
  const sectionIdMap = new Map()
  const usedInputSectionIds = new Set()

  snapshot.sections.forEach((section, index) => {
    const inputId = String(section.id || `new-section-${index}`)
    if (usedInputSectionIds.has(inputId)) {
      throw new VideoHubApiError(`La sección “${section.name || inputId}” tiene un identificador duplicado.`, {
        code: 'DUPLICATE_SECTION_ID',
      })
    }
    usedInputSectionIds.add(inputId)
    sectionIdMap.set(inputId, isUuid(section.id) ? section.id : createUuid())
  })

  const selectedSlugs = new Set()
  const sectionRows = snapshot.sections.map((section, index) => {
    const inputId = String(section.id || `new-section-${index}`)
    const id = sectionIdMap.get(inputId)
    const name = String(section.name || '').trim()
    if (!name) {
      throw new VideoHubApiError('Todas las secciones necesitan un nombre.', {
        code: 'INVALID_SECTION',
      })
    }

    const storedSlug = existingSectionById.get(id)?.slug
    const requestedSlug = SLUG_PATTERN.test(String(section.slug || '')) ? section.slug : ''
    const baseSlug = storedSlug || requestedSlug || slugify(name)
    let slug = baseSlug
    let suffix = 2
    while (
      selectedSlugs.has(slug)
      || (existingSlugOwner.has(slug) && existingSlugOwner.get(slug) !== id)
    ) {
      slug = `${baseSlug}-${suffix}`
      suffix += 1
    }
    selectedSlugs.add(slug)

    return {
      id,
      organization_id: organizationId,
      name,
      slug,
      icon: String(section.icon || 'layers').trim() || 'layers',
      sort_order: Number.isInteger(section.order) && section.order >= 0 ? section.order : index,
      active: true,
    }
  })

  const sectionRoleRows = snapshot.sections.flatMap((section, index) => {
    const inputId = String(section.id || `new-section-${index}`)
    const sectionId = sectionIdMap.get(inputId)
    return VIEWER_ROLES.map((role) => ({
      section_id: sectionId,
      organization_id: organizationId,
      role,
      visible: Array.isArray(section.roles) && section.roles.includes(role),
    }))
  })

  const videoIdMap = new Map()
  const usedInputVideoIds = new Set()
  snapshot.videos.forEach((video, index) => {
    const inputId = String(video.id || `new-video-${index}`)
    if (usedInputVideoIds.has(inputId)) {
      throw new VideoHubApiError(`El video “${video.title || inputId}” tiene un identificador duplicado.`, {
        code: 'DUPLICATE_VIDEO_ID',
      })
    }
    usedInputVideoIds.add(inputId)
    videoIdMap.set(inputId, isUuid(video.id) ? video.id : createUuid())
  })

  const videoRows = []
  const sourceRows = []
  const assignmentRows = []

  snapshot.videos.forEach((video, index) => {
    const inputId = String(video.id || `new-video-${index}`)
    const id = videoIdMap.get(inputId)
    const title = String(video.title || '').trim()
    if (!title) {
      throw new VideoHubApiError('Todos los videos necesitan un título.', {
        code: 'INVALID_VIDEO',
      })
    }

    const duration = String(video.duration || 'Video').trim().slice(0, 20) || 'Video'
    const createdAt = Number.isNaN(Date.parse(video.createdAt)) ? new Date().toISOString() : video.createdAt
    videoRows.push({
      id,
      organization_id: organizationId,
      title,
      description: String(video.description || '').trim(),
      duration_label: duration,
      duration_seconds: parseDurationSeconds(duration),
      featured: Boolean(video.featured),
      active: true,
      created_at: createdAt,
    })

    const previousSource = video.source
    const currentUrl = String(video.url || '').trim()
    const sourceWasNotChanged = previousSource && (
      currentUrl === String(previousSource.resolvedUrl || '')
      || currentUrl === String(previousSource.sourceUrl || '')
      || (previousSource.provider === 'supabase_storage' && !currentUrl)
    )

    if (sourceWasNotChanged && DATABASE_PROVIDERS.has(previousSource.provider)) {
      sourceRows.push({
        video_id: id,
        provider: previousSource.provider,
        source_ref: String(previousSource.sourceRef || previousSource.storageObjectPath || previousSource.sourceUrl || '').trim(),
        source_url: previousSource.provider === 'supabase_storage' ? null : previousSource.sourceUrl,
        thumbnail_url: /^https:\/\//i.test(String(video.thumbnailUrl || '')) ? video.thumbnailUrl.trim() : null,
        storage_bucket: previousSource.provider === 'supabase_storage' ? previousSource.storageBucket : null,
        storage_object_path: previousSource.provider === 'supabase_storage' ? previousSource.storageObjectPath : null,
        metadata: previousSource.metadata && typeof previousSource.metadata === 'object' ? previousSource.metadata : {},
      })
    } else {
      const parsedSource = getVideoSource(currentUrl)
      if (!currentUrl || ['empty', 'invalid'].includes(parsedSource.type) || !/^https:\/\//i.test(currentUrl)) {
        throw new VideoHubApiError(`El enlace del video “${title}” debe ser una URL HTTPS válida.`, {
          code: 'INVALID_VIDEO_URL',
        })
      }
      const provider = DATABASE_PROVIDERS.has(parsedSource.provider) ? parsedSource.provider : 'direct'
      sourceRows.push({
        video_id: id,
        provider,
        source_ref: String(parsedSource.id || currentUrl).trim(),
        source_url: currentUrl,
        thumbnail_url: /^https:\/\//i.test(String(video.thumbnailUrl || '')) ? video.thumbnailUrl.trim() : null,
        storage_bucket: null,
        storage_object_path: null,
        metadata: {},
      })
    }

    VIEWER_ROLES.forEach((role) => {
      const inputSectionId = video.assignments?.[role]
      if (!inputSectionId) return
      const sectionId = sectionIdMap.get(String(inputSectionId))
      if (!sectionId) {
        throw new VideoHubApiError(`El video “${title}” apunta a una sección que ya no existe.`, {
          code: 'INVALID_VIDEO_ASSIGNMENT',
        })
      }
      assignmentRows.push({
        video_id: id,
        organization_id: organizationId,
        role,
        section_id: sectionId,
        visible: true,
        is_locked: Boolean(video.locked?.[role]),
        sort_order: index,
      })
    })
  })

  for (const source of sourceRows) {
    if (!source.source_ref) {
      throw new VideoHubApiError('Cada video necesita una fuente válida.', {
        code: 'INVALID_VIDEO_SOURCE',
      })
    }
    if (source.provider === 'supabase_storage' && (!source.storage_bucket || !source.storage_object_path)) {
      throw new VideoHubApiError('La fuente de Storage está incompleta.', {
        code: 'INVALID_STORAGE_SOURCE',
      })
    }
  }

  return { sectionRows, sectionRoleRows, videoRows, sourceRows, assignmentRows }
}

async function upsertRows(table, rows, onConflict) {
  if (!rows.length) return
  const { error } = await getClient().from(table).upsert(rows, { onConflict })
  throwDatabaseError(error, `No se pudo guardar ${table}`)
}

/**
 * Sincroniza el estado administrativo con las tablas públicas. La operación
 * usa exclusivamente la sesión autenticada y la publishable key; RLS exige
 * que el perfil actual sea admin. Devuelve el snapshot ya persistido, con los
 * UUID definitivos, para reemplazar el estado local después de guardar.
 */
export async function saveAdminSnapshot(snapshot, options = {}) {
  const client = getClient()
  const context = options.context || await getCurrentAccessContext()
  if (context.role !== 'admin') {
    throw new VideoHubApiError('Solo un administrador puede guardar la configuración.', {
      code: 'ADMIN_REQUIRED',
    })
  }

  const organizationId = context.organizationId
  const [existingSectionsResult, existingVideosResult, existingAssignmentsResult] = await Promise.all([
    client.from('sections').select('id,slug,active').eq('organization_id', organizationId),
    client.from('videos').select('id,active').eq('organization_id', organizationId),
    client.from('video_assignments').select('video_id,role').eq('organization_id', organizationId),
  ])
  throwDatabaseError(existingSectionsResult.error, 'No se pudo preparar la sincronización de secciones')
  throwDatabaseError(existingVideosResult.error, 'No se pudo preparar la sincronización de videos')
  throwDatabaseError(existingAssignmentsResult.error, 'No se pudo preparar la sincronización de permisos')

  // Validar y transformar todo antes de efectuar la primera escritura.
  const prepared = prepareSnapshot(snapshot, organizationId, existingSectionsResult.data || [])
  const desiredSectionIds = new Set(prepared.sectionRows.map((row) => row.id))
  const desiredVideoIds = new Set(prepared.videoRows.map((row) => row.id))
  const desiredAssignmentKeys = new Set(
    prepared.assignmentRows.map((row) => `${row.video_id}:${row.role}`),
  )

  const organizationName = String(snapshot.organization || '').trim()
  const logoUrl = String(snapshot.logoUrl || '').trim()
  const normalizedSettings = snapshot.settings ? {
    product_name: String(snapshot.settings.productName || 'Video Hub').trim() || 'Video Hub',
    welcome_title: String(snapshot.settings.welcomeTitle || 'Video Hub').trim() || 'Video Hub',
    welcome_message: String(snapshot.settings.welcomeMessage || '').trim(),
    support_message: String(snapshot.settings.supportMessage || '').trim(),
    allow_light_mode: snapshot.settings.allowLightMode !== false,
  } : null

  const session = await getCurrentSession()
  if (!session?.access_token) {
    throw new VideoHubApiError('La sesión administrativa ya no es válida.', {
      code: 'SESSION_REQUIRED',
    })
  }

  const atomicSave = await requestFunction(SAVE_SNAPSHOT_FUNCTION_URL, {
    accessToken: session.access_token,
    body: {
      expectedRevision: Number.isSafeInteger(Number(snapshot.revision))
        ? Number(snapshot.revision)
        : 0,
      snapshot: {
      organization: organizationName,
      logo_url: logoUrl,
      settings: normalizedSettings,
      sections: prepared.sectionRows,
      section_roles: prepared.sectionRoleRows,
      videos: prepared.videoRows,
      video_sources: prepared.sourceRows,
      video_assignments: prepared.assignmentRows,
      },
    },
  })

  if (atomicSave.ok) {
    const savedContext = {
      ...context,
      contentRevision: Number.isSafeInteger(Number(atomicSave.revision))
        ? Number(atomicSave.revision)
        : Number(snapshot.revision || 0) + 1,
    }
    return loadVideoHubSnapshot({ context: savedContext, codes: snapshot.codes })
  }

  if (!atomicSave.unsupported) {
    throw new VideoHubApiError('No se pudo guardar la configuración.', {
      code: 'ATOMIC_SAVE_FAILED',
    })
  }

  // Compatibilidad temporal para un proyecto que todavía no aplicó la última
  // migración. Al instalarla, todas las escrituras pasan por la RPC atómica.
  if (organizationName) {
    const { error } = await client
      .from('organizations')
      .update({ name: organizationName, logo_url: logoUrl || null })
      .eq('id', organizationId)
    throwDatabaseError(error, 'No se pudo guardar el nombre de la organización')
  }

  if (normalizedSettings) {
    const { error } = await client.from('app_settings').upsert({
      organization_id: organizationId,
      ...normalizedSettings,
    }, { onConflict: 'organization_id' })
    throwDatabaseError(error, 'No se pudo guardar la configuración general')
  }

  await upsertRows('sections', prepared.sectionRows, 'id')
  await upsertRows('section_roles', prepared.sectionRoleRows, 'section_id,role')
  await upsertRows('videos', prepared.videoRows, 'id')
  await upsertRows('video_sources', prepared.sourceRows, 'video_id')
  await upsertRows('video_assignments', prepared.assignmentRows, 'video_id,role')

  // Una asignación eliminada en React también debe desaparecer en Supabase.
  for (const role of VIEWER_ROLES) {
    const staleAssignmentVideoIds = (existingAssignmentsResult.data || [])
      .filter((row) => (
        row.role === role
        && desiredVideoIds.has(row.video_id)
        && !desiredAssignmentKeys.has(`${row.video_id}:${row.role}`)
      ))
      .map((row) => row.video_id)
    await deleteRowsByIds('video_assignments', 'video_id', staleAssignmentVideoIds, { role })
  }

  const staleVideoIds = (existingVideosResult.data || [])
    .filter((row) => row.active === true && !desiredVideoIds.has(row.id))
    .map((row) => row.id)
  await archiveRowsByIds('videos', 'id', staleVideoIds, { organization_id: organizationId })

  const staleSectionIds = (existingSectionsResult.data || [])
    .filter((row) => row.active === true && !desiredSectionIds.has(row.id))
    .map((row) => row.id)
  await archiveRowsByIds('sections', 'id', staleSectionIds, { organization_id: organizationId })

  return loadVideoHubSnapshot({ context, codes: snapshot.codes })
}
