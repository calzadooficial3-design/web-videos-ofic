import { getVideoSource, parseDurationSeconds } from '../videoUtils'
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
const LOGIN_FUNCTION_URL = '/.netlify/functions/login-with-password'
const CREATE_USER_FUNCTION_URL = '/.netlify/functions/create-user'
const UPDATE_USER_FUNCTION_URL = '/.netlify/functions/update-user'
const SAVE_SNAPSHOT_FUNCTION_URL = '/.netlify/functions/save-admin-snapshot'
const IMPORT_DRIVE_VIDEOS_FUNCTION_URL = '/.netlify/functions/import-drive-videos'

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

function formatDuration(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0) return 'Video'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
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

async function dispatchDriveVideoImports(videoIds, accessToken) {
  const ids = [...new Set((videoIds || []).filter(isUuid))].slice(0, 10)
  if (!ids.length || !accessToken) return

  const requests = await Promise.allSettled(ids.map((videoId) => requestFunction(IMPORT_DRIVE_VIDEOS_FUNCTION_URL, {
    accessToken,
    body: { videoIds: [videoId] },
  })))
  const failedRequest = requests.find((result) => result.status === 'rejected')
  if (failedRequest) throw failedRequest.reason
}

export async function queueDriveVideoImports(videoIds) {
  const session = await getCurrentSession()
  if (!session?.access_token) return
  await dispatchDriveVideoImports(videoIds, session.access_token)
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

export async function loginWithCredentials(username, password) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  if (!normalizedUsername) {
    throw new VideoHubApiError('Ingresa tu usuario.', {
      code: 'EMPTY_USERNAME',
    })
  }
  if (!String(password || '')) {
    throw new VideoHubApiError('Ingresa tu contraseña.', {
      code: 'EMPTY_PASSWORD',
    })
  }

  const payload = await requestFunction(LOGIN_FUNCTION_URL, {
    body: { username: normalizedUsername, password },
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

async function withAdminSession(callback) {
  const session = await getCurrentSession()
  if (!session?.access_token) {
    throw new VideoHubApiError('La sesión administrativa ya no es válida.', {
      code: 'SESSION_REQUIRED',
    })
  }
  return callback(session.access_token)
}

export async function listManagedUsers() {
  const context = await getCurrentAccessContext()
  const { data, error } = await getClient()
    .from('profiles')
    .select('user_id,username,display_name,role,active,created_at')
    .eq('organization_id', context.organizationId)
    .in('role', ['operator', 'boss'])
    .order('created_at')
  throwDatabaseError(error, 'No se pudieron leer los usuarios')

  return (data || []).map((row) => ({
    userId: row.user_id,
    username: row.username || '',
    displayName: row.display_name || '',
    role: row.role,
    active: Boolean(row.active),
    createdAt: row.created_at,
  }))
}

export async function createUser({ username, password, role, displayName }) {
  return withAdminSession((accessToken) => requestFunction(CREATE_USER_FUNCTION_URL, {
    body: { username, password, role, displayName },
    accessToken,
  }))
}

export async function updateUser({ userId, displayName, role, active, newPassword }) {
  return withAdminSession((accessToken) => requestFunction(UPDATE_USER_FUNCTION_URL, {
    body: { userId, displayName, role, active, newPassword },
    accessToken,
  }))
}

/**
 * Reporta el punto más lejano alcanzado en un video para el usuario actual.
 * El trigger de la base de datos decide si eso cuenta como "visto" (mitad o
 * más de la duración real guardada en `videos`); aquí solo enviamos segundos.
 */
export async function recordVideoProgress({ videoId, userId, progressSeconds, durationSeconds }) {
  if (!videoId || !userId || !Number.isFinite(progressSeconds)) return
  const payload = {
    video_id: videoId,
    user_id: userId,
    max_progress_seconds: Math.max(0, Math.floor(progressSeconds)),
  }
  // Cuando el reproductor conoce la duración real (video nativo o YouTube),
  // se reporta para que el servidor pueda autocompletar videos.duration_seconds
  // si el admin la dejó en blanco al crear el video.
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    payload.reported_duration_seconds = Math.round(durationSeconds)
  }
  const { error } = await getClient()
    .from('video_watch_progress')
    .upsert(payload, { onConflict: 'video_id,user_id' })
  throwDatabaseError(error, 'No se pudo guardar el progreso del video')
}

export async function listWatchProgress() {
  const context = await getCurrentAccessContext()
  const { data, error } = await getClient()
    .from('video_watch_progress')
    .select('video_id,user_id,completed,max_progress_seconds,last_watched_at')
    .eq('organization_id', context.organizationId)
  throwDatabaseError(error, 'No se pudieron leer los progresos')

  return (data || []).map((row) => ({
    videoId: row.video_id,
    userId: row.user_id,
    completed: Boolean(row.completed),
    maxProgressSeconds: row.max_progress_seconds,
    lastWatchedAt: row.last_watched_at,
  }))
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

/**
 * Sincroniza el estado administrativo únicamente mediante la Function de
 * Netlify y la RPC atómica de Supabase. Devuelve el snapshot confirmado por la
 * base de datos, con los UUID definitivos.
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
  const existingSectionsResult = await client
    .from('sections')
    .select('id,slug,active')
    .eq('organization_id', organizationId)
  throwDatabaseError(existingSectionsResult.error, 'No se pudo preparar la sincronización de secciones')

  // Validar y transformar todo antes de efectuar la primera escritura.
  const prepared = prepareSnapshot(snapshot, organizationId, existingSectionsResult.data || [])

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

  if (!atomicSave.ok) {
    throw new VideoHubApiError('No se pudo guardar la configuración.', {
      code: 'ATOMIC_SAVE_FAILED',
    })
  }

  const driveVideoIds = prepared.sourceRows
    .filter((source) => source.provider === 'google_drive')
    .map((source) => source.video_id)
  if (driveVideoIds.length && atomicSave.drive_import_queued !== true) {
    // La importación ocurre en segundo plano. Si se interrumpe, el enlace de
    // Drive ya guardado sigue funcionando y un próximo guardado vuelve a intentar.
    await dispatchDriveVideoImports(driveVideoIds, session.access_token)
  }

  const savedContext = {
    ...context,
    contentRevision: Number.isSafeInteger(Number(atomicSave.revision))
      ? Number(atomicSave.revision)
      : Number(snapshot.revision || 0) + 1,
  }
  return loadVideoHubSnapshot({ context: savedContext })
}
