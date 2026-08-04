import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  Film,
  FolderCog,
  Home,
  ImageIcon,
  KeyRound,
  Layers3,
  LayoutDashboard,
  Lightbulb,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UploadCloud,
  UsersRound,
  Video,
  X,
} from 'lucide-react'
import { ROLE_META } from './data'
import {
  getCurrentAccessContext,
  getCurrentSession,
  loadVideoHubSnapshot,
  loginWithCode as authenticateWithCode,
  onAuthStateChange,
  queueDriveVideoImports,
  rotateAccessCodes,
  saveAdminSnapshot,
  signOut,
} from './lib/videoHubApi'
import { createAdminSaveRevisionTracker } from './lib/adminSaveRevision'
import {
  getSourceAccent,
  getThumbnailSeekTime,
  getVideoSource,
  getVideoThumbnailUrl,
  resolveVideoThumbnail,
} from './videoUtils'

const EMPTY_DATA = {
  organization: 'Almacén de Remates',
  organizationId: '',
  settings: null,
  sections: [],
  videos: [],
}
const SAVE_DELAY_MS = 700

const ICONS = {
  home: Home,
  layers: Layers3,
  shield: ShieldCheck,
  briefcase: BriefcaseBusiness,
  sparkles: Sparkles,
  book: BookOpen,
  film: Film,
  lightbulb: Lightbulb,
}

const SECTION_ICON_OPTIONS = [
  { value: 'layers', label: 'Capas' },
  { value: 'shield', label: 'Seguridad' },
  { value: 'briefcase', label: 'Trabajo' },
  { value: 'sparkles', label: 'Novedades' },
  { value: 'book', label: 'Formación' },
  { value: 'film', label: 'Videos' },
  { value: 'lightbulb', label: 'Ideas' },
]

const VIEWER_ROLES = ['operator', 'boss']

const AUDIENCE_META = {
  operator: { label: 'Operante', groupLabel: 'Operante', description: 'Videos exclusivos para el rol Operante' },
  boss: { label: 'Jefe', groupLabel: 'Jefe', description: 'Videos exclusivos para el rol Jefe' },
  both: { label: 'Ambos', groupLabel: 'Todos', description: 'Videos destinados a Operante y Jefe' },
  none: { label: 'Sin asignar', groupLabel: 'Sin asignar', description: 'Videos que necesitan una audiencia y una sección' },
}

const isVideoAssignedTo = (video, role) => Boolean(video.assignments?.[role])
const isVideoLockedFor = (video, role) => isVideoAssignedTo(video, role) && Boolean(video.locked?.[role])

function getVideoAudience(video) {
  const forOperator = isVideoAssignedTo(video, 'operator')
  const forBoss = isVideoAssignedTo(video, 'boss')
  if (forOperator && forBoss) return 'both'
  if (forOperator) return 'operator'
  if (forBoss) return 'boss'
  return 'none'
}

function getPersistedVideoSource(video) {
  const source = getVideoSource(video?.url || '')
  const originalProvider = video?.source?.metadata?.originalProvider

  if (
    video?.source?.provider === 'supabase_storage'
    && originalProvider === 'google_drive'
    && source.type === 'video'
  ) {
    return { ...source, label: 'Google Drive', originalProvider }
  }

  return source
}

function editableSnapshotFingerprint(snapshot) {
  if (!snapshot) return ''
  return JSON.stringify({
    organization: snapshot.organization || '',
    settings: snapshot.settings || null,
    sections: (snapshot.sections || []).map((section) => ({
      id: section.id,
      name: section.name,
      slug: section.slug || '',
      icon: section.icon,
      roles: [...(section.roles || [])].sort(),
      order: section.order,
    })),
    videos: (snapshot.videos || []).map((video) => ({
      id: video.id,
      title: video.title,
      description: video.description,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl || '',
      duration: video.duration,
      assignments: video.assignments || {},
      locked: video.locked || {},
      featured: Boolean(video.featured),
      createdAt: video.createdAt,
      source: video.source || null,
    })),
  })
}

function getErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback
}

function App() {
  const [theme, setTheme] = useState('dark')
  const [data, setData] = useState(null)
  const [session, setSession] = useState(undefined)
  const [accessContext, setAccessContext] = useState(null)
  const [loadingData, setLoadingData] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveState, setSaveState] = useState({ status: 'idle', error: '' })
  const [saveRetry, setSaveRetry] = useState(0)
  const [loggingOut, setLoggingOut] = useState(false)
  const loadEpochRef = useRef(0)
  const lastSavedFingerprintRef = useRef('')
  const latestDataRef = useRef(null)
  const saveTimerRef = useRef(null)
  const saveQueueRef = useRef(Promise.resolve())
  const saveRevisionRef = useRef(0)
  const contentRevisionTrackerRef = useRef(null)
  const backgroundRefreshRef = useRef(false)
  const driveImportRequestKeyRef = useRef('')
  const sessionUserIdRef = useRef(null)
  const loginInProgressRef = useRef(false)

  if (!contentRevisionTrackerRef.current) {
    contentRevisionTrackerRef.current = createAdminSaveRevisionTracker()
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const clearAuthenticatedState = useCallback(() => {
    loadEpochRef.current += 1
    saveRevisionRef.current += 1
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setSession(null)
    sessionUserIdRef.current = null
    setAccessContext(null)
    setData(null)
    latestDataRef.current = null
    lastSavedFingerprintRef.current = ''
    driveImportRequestKeyRef.current = ''
    contentRevisionTrackerRef.current.reset()
    setLoadingData(false)
    setLoadError('')
    setSaveState({ status: 'idle', error: '' })
  }, [])

  const hydrateSession = useCallback(async (nextSession, knownContext = null) => {
    if (!nextSession) {
      clearAuthenticatedState()
      return null
    }

    const epoch = ++loadEpochRef.current
    sessionUserIdRef.current = nextSession.user?.id || null
    setSession(nextSession)
    setLoadingData(true)
    setLoadError('')

    try {
      const context = knownContext || await getCurrentAccessContext()
      const snapshot = await loadVideoHubSnapshot({ context })
      if (epoch !== loadEpochRef.current) return null

      contentRevisionTrackerRef.current.reset(snapshot.revision)
      lastSavedFingerprintRef.current = editableSnapshotFingerprint(snapshot)
      latestDataRef.current = snapshot
      setAccessContext(context)
      setData(snapshot)
      setSaveState({ status: 'saved', error: '' })
      return snapshot
    } catch (error) {
      if (epoch === loadEpochRef.current) {
        setAccessContext(null)
        setData(null)
        setLoadError(getErrorMessage(error, 'No se pudieron cargar los datos de Supabase.'))
      }
      throw error
    } finally {
      if (epoch === loadEpochRef.current) setLoadingData(false)
    }
  }, [clearAuthenticatedState])

  useEffect(() => {
    let active = true

    getCurrentSession()
      .then((currentSession) => {
        if (!active) return null
        return hydrateSession(currentSession)
      })
      .catch((error) => {
        if (!active) return
        setSession(null)
        setLoadingData(false)
        setLoadError(getErrorMessage(error, 'No se pudo iniciar la conexión con Supabase.'))
      })

    const unsubscribe = onAuthStateChange((event, nextSession) => {
      if (!active) return
      if (event === 'SIGNED_OUT') {
        clearAuthenticatedState()
      } else if (nextSession && ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
        setSession(nextSession)
        if (
          event === 'SIGNED_IN'
          && !loginInProgressRef.current
          && nextSession.user?.id !== sessionUserIdRef.current
        ) {
          window.setTimeout(() => hydrateSession(nextSession).catch(() => undefined), 0)
        }
      }
    })

    return () => {
      active = false
      loadEpochRef.current += 1
      unsubscribe()
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [clearAuthenticatedState, hydrateSession])

  useEffect(() => {
    latestDataRef.current = data
  }, [data])

  useEffect(() => {
    if (
      accessContext
      && accessContext.role !== 'admin'
      && data?.settings?.allowLightMode === false
      && theme !== 'dark'
    ) setTheme('dark')
  }, [accessContext, data?.settings?.allowLightMode, theme])

  useEffect(() => {
    if (!data || loadingData || accessContext?.role !== 'admin') return undefined

    const fingerprint = editableSnapshotFingerprint(data)
    if (fingerprint === lastSavedFingerprintRef.current) return undefined

    const revision = ++saveRevisionRef.current
    setSaveState({ status: 'pending', error: '' })
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)

    saveTimerRef.current = window.setTimeout(() => {
      const snapshot = data
      const context = accessContext
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (revision < saveRevisionRef.current) return
          setSaveState({ status: 'saving', error: '' })
          const savedSnapshot = await saveAdminSnapshot(
            contentRevisionTrackerRef.current.rebase(snapshot),
            { context },
          )
          contentRevisionTrackerRef.current.confirm(savedSnapshot.revision)
          if (revision === saveRevisionRef.current) {
            const savedFingerprint = editableSnapshotFingerprint(savedSnapshot)
            lastSavedFingerprintRef.current = savedFingerprint
            latestDataRef.current = savedSnapshot
            setData(savedSnapshot)
            setSaveState({ status: 'saved', error: '' })
          } else {
            lastSavedFingerprintRef.current = fingerprint
          }
        })
        .catch((error) => {
          if (revision === saveRevisionRef.current) {
            setSaveState({
              status: 'error',
              error: getErrorMessage(error, 'No se pudieron guardar los cambios.'),
              code: error?.code || '',
            })
          }
        })
    }, SAVE_DELAY_MS)

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [accessContext, data, loadingData, saveRetry])

  useEffect(() => {
    if (!session?.user?.id || !accessContext) return undefined
    let active = true

    const refreshFromSupabase = async () => {
      if (!active || document.visibilityState === 'hidden' || backgroundRefreshRef.current) return
      const currentData = latestDataRef.current
      const hadPendingAdminChanges = (
        accessContext.role === 'admin'
        && currentData
        && editableSnapshotFingerprint(currentData) !== lastSavedFingerprintRef.current
      )

      const epoch = loadEpochRef.current
      backgroundRefreshRef.current = true
      try {
        const freshContext = await getCurrentAccessContext()
        if (!freshContext.active || freshContext.userId !== accessContext.userId) {
          await signOut().catch(() => undefined)
          clearAuthenticatedState()
          return
        }
        const accessChanged = (
          freshContext.role !== accessContext.role
          || freshContext.organizationId !== accessContext.organizationId
        )
        if (hadPendingAdminChanges && !accessChanged) return
        const snapshot = await loadVideoHubSnapshot({
          context: freshContext,
          previousSnapshot: latestDataRef.current,
        })
        if (!active || epoch !== loadEpochRef.current) return

        const latestData = latestDataRef.current
        if (
          freshContext.role === 'admin'
          && !accessChanged
          && latestData
          && editableSnapshotFingerprint(latestData) !== lastSavedFingerprintRef.current
        ) return

        contentRevisionTrackerRef.current.reset(snapshot.revision)
        lastSavedFingerprintRef.current = editableSnapshotFingerprint(snapshot)
        latestDataRef.current = snapshot
        if (
          freshContext.role !== accessContext.role
          || freshContext.organizationId !== accessContext.organizationId
        ) setAccessContext(freshContext)
        setData(snapshot)
      } catch (error) {
        if (error?.code === 'PROFILE_NOT_FOUND') {
          await signOut().catch(() => undefined)
          clearAuthenticatedState()
        }
        // Una interrupción temporal no reemplaza los datos que ya están visibles.
      } finally {
        backgroundRefreshRef.current = false
      }
    }

    const handleFocus = () => { refreshFromSupabase() }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshFromSupabase()
    }
    const interval = window.setInterval(refreshFromSupabase, 15_000)
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      active = false
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [accessContext, clearAuthenticatedState, session?.user?.id])

  useEffect(() => {
    if (accessContext?.role !== 'admin' || !data?.videos?.length) return

    const driveVideos = data.videos.filter((video) => video.source?.provider === 'google_drive')
    const requestKey = driveVideos
      .map((video) => `${video.id}:${video.source?.sourceRef || ''}`)
      .sort()
      .join('|')

    if (!requestKey) {
      driveImportRequestKeyRef.current = ''
      return
    }
    if (driveImportRequestKeyRef.current === requestKey) return

    driveImportRequestKeyRef.current = requestKey
    queueDriveVideoImports(driveVideos.map((video) => video.id)).catch(() => {
      // Netlify reintenta las ejecuciones fallidas; el enlace Drive se conserva.
      if (driveImportRequestKeyRef.current === requestKey) {
        driveImportRequestKeyRef.current = ''
      }
    })
  }, [accessContext?.role, data?.videos])

  useEffect(() => {
    const warnBeforeLeaving = (event) => {
      if (accessContext?.role !== 'admin' || !data) return
      if (editableSnapshotFingerprint(data) === lastSavedFingerprintRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [accessContext?.role, data])

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  const loginWithCode = async (code) => {
    loginInProgressRef.current = true
    try {
      const result = await authenticateWithCode(code)
      await hydrateSession(result.session, result.context)
      return true
    } finally {
      loginInProgressRef.current = false
    }
  }

  const retryLoad = () => {
    if (session) hydrateSession(session).catch(() => undefined)
  }

  const retrySave = () => {
    if (saveState.code === 'STALE_SNAPSHOT') {
      const confirmed = window.confirm(
        'Hay cambios más recientes en Supabase. ¿Quieres descartar esta copia y recargar la versión guardada?',
      )
      if (confirmed && session) hydrateSession(session).catch(() => undefined)
      return
    }
    lastSavedFingerprintRef.current = `retry-${Date.now()}`
    setSaveRetry((value) => value + 1)
  }

  const updateAccessCodes = async (codes) => {
    const result = await rotateAccessCodes(codes)
    if (result?.reauthenticate) {
      await signOut().catch(() => undefined)
      clearAuthenticatedState()
    }
    return result
  }

  const logout = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    setLoadError('')

    try {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveRevisionRef.current += 1
      await saveQueueRef.current.catch(() => undefined)

      const currentData = latestDataRef.current
      if (
        accessContext?.role === 'admin'
        && currentData
        && editableSnapshotFingerprint(currentData) !== lastSavedFingerprintRef.current
      ) {
        setSaveState({ status: 'saving', error: '' })
        const savedSnapshot = await saveAdminSnapshot(
          contentRevisionTrackerRef.current.rebase(currentData),
          { context: accessContext },
        )
        contentRevisionTrackerRef.current.confirm(savedSnapshot.revision)
        lastSavedFingerprintRef.current = editableSnapshotFingerprint(savedSnapshot)
      }

      await signOut()
      clearAuthenticatedState()
    } catch (error) {
      setSaveState({
        status: 'error',
        error: getErrorMessage(error, 'No se pudo guardar o cerrar la sesión.'),
        code: error?.code || '',
      })
    } finally {
      setLoggingOut(false)
    }
  }

  if (session === undefined || (session && loadingData)) {
    return <AppStatusScreen title="Conectando con Supabase" text="Estamos cargando tu contenido y permisos." />
  }

  if (!session) {
    return <LoginScreen data={EMPTY_DATA} theme={theme} toggleTheme={toggleTheme} onLogin={loginWithCode} serviceError={loadError} />
  }

  if (loadError || !data || !accessContext) {
    return (
      <AppStatusScreen
        error
        title="No se pudo cargar la plataforma"
        text={loadError || 'La sesión no tiene un perfil activo en Supabase.'}
        actions={<><button className="primary-button" onClick={retryLoad}>Reintentar</button><button className="secondary-button" onClick={logout}>Cerrar sesión</button></>}
      />
    )
  }

  if (accessContext.role === 'admin') {
    return (
      <AdminApp
        data={data}
        setData={setData}
        theme={theme}
        toggleTheme={toggleTheme}
        saveState={saveState}
        onRetrySave={retrySave}
        onRotateCodes={updateAccessCodes}
        loggingOut={loggingOut}
        onLogout={logout}
      />
    )
  }

  return (
    <ViewerApp
      role={accessContext.role}
      data={data}
      theme={theme}
      toggleTheme={toggleTheme}
      onLogout={logout}
    />
  )
}

function AppStatusScreen({ title, text, actions = null, error = false }) {
  return (
    <main className={`app-status-screen ${error ? 'app-status-screen--error' : ''}`}>
      <CompanyLogo />
      <span className="app-status-screen__icon">{error ? <CircleHelp size={26} /> : <span className="loading-spinner" />}</span>
      <h1>{title}</h1>
      <p>{text}</p>
      {actions && <div className="app-status-screen__actions">{actions}</div>}
    </main>
  )
}

function CompanyLogo({ compact = false }) {
  return (
    <div className={`company-brand ${compact ? 'company-brand--compact' : ''}`}>
      <span className="company-brand__plate">
        <img src="/brand/almacen-remates-web.png" alt="Almacén de Remates" />
      </span>
      {!compact && (
        <span className="company-brand__product">
          <strong>PORTAL PRIVADO</strong>
          <small>VIDEO HUB</small>
        </span>
      )}
    </div>
  )
}

function ThemeToggle({ theme, onToggle, label = true }) {
  return (
    <button className="theme-toggle" type="button" onClick={onToggle} aria-label="Cambiar tema">
      <span className="theme-toggle__icon">{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
      {label && <span>{theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</span>}
    </button>
  )
}

function VideoThumbnail({ video, className = '' }) {
  const source = getPersistedVideoSource(video)
  const preferredThumbnail = video?.thumbnailUrl?.trim() || source.thumbnailUrl || ''
  const [thumbnailUrl, setThumbnailUrl] = useState(preferredThumbnail)
  const [videoFailed, setVideoFailed] = useState(false)
  const [frameReady, setFrameReady] = useState(false)

  useEffect(() => {
    let active = true
    setThumbnailUrl(preferredThumbnail)
    setVideoFailed(false)
    setFrameReady(false)

    if (!preferredThumbnail && source.provider === 'vimeo') {
      resolveVideoThumbnail(video.url).then((url) => {
        if (active) setThumbnailUrl(url)
      })
    }

    return () => { active = false }
  }, [preferredThumbnail, source.provider, video?.url])

  if (thumbnailUrl) {
    return (
      <img
        className={`video-thumbnail-media ${className}`}
        src={thumbnailUrl}
        alt={`Miniatura de ${video.title || 'video'}`}
        loading="lazy"
        onError={() => setThumbnailUrl('')}
      />
    )
  }

  if (source.type === 'video' && !videoFailed) {
    const frameUrl = getVideoThumbnailUrl(source.embedUrl)
    const revealFrameIfReady = (element) => {
      const target = getThumbnailSeekTime(element.duration)
      if (!element.seeking && Math.abs(element.currentTime - target) <= 0.15) {
        setFrameReady(true)
      }
    }

    return (
      <video
        key={frameUrl}
        className={`video-thumbnail-media video-thumbnail-media--frame ${frameReady ? 'is-ready' : ''} ${className}`}
        src={frameUrl}
        preload="metadata"
        muted
        playsInline
        aria-label={`Miniatura de ${video.title || 'video'}`}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget
          const target = getThumbnailSeekTime(element.duration)

          if (Math.abs(element.currentTime - target) <= 0.05) {
            setFrameReady(true)
            return
          }

          element.currentTime = target
        }}
        onLoadedData={(event) => revealFrameIfReady(event.currentTarget)}
        onCanPlay={(event) => revealFrameIfReady(event.currentTarget)}
        onSeeked={(event) => revealFrameIfReady(event.currentTarget)}
        onError={() => setVideoFailed(true)}
      />
    )
  }

  return null
}

function LoginScreen({ data, theme, toggleTheme, onLogin, serviceError = '' }) {
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    setError('')
    if (!code.trim()) {
      setError('Escribe tu código de acceso para continuar.')
      return
    }
    setLoading(true)
    try {
      await onLogin(code)
    } catch (loginError) {
      setError(getErrorMessage(loginError, 'El código no es válido. Compruébalo e inténtalo nuevamente.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-page__glow login-page__glow--one" />
      <div className="login-page__glow login-page__glow--two" />
      <div className="login-grid" aria-hidden="true" />

      <header className="login-header">
        <CompanyLogo />
        <ThemeToggle theme={theme} onToggle={toggleTheme} label={false} />
      </header>

      <section className="login-shell">
        <div className="login-intro">
          <span className="eyebrow"><Sparkles size={14} /> Conocimiento que impulsa</span>
          <h1>Todo lo que necesitas aprender, <em>en un solo lugar.</em></h1>
          <p>Accede a videos, procesos y recursos seleccionados especialmente para tu función.</p>
          <div className="login-proof">
            <div className="avatar-stack" aria-hidden="true">
              <span>AM</span><span>CL</span><span>JR</span>
            </div>
            <div><strong>Contenido privado</strong><small>Organizado y siempre disponible</small></div>
          </div>
        </div>

        <div className="login-card-wrap">
          <div className="login-card">
            <div className="login-card__icon"><LockKeyhole size={23} /></div>
            <div className="login-card__heading">
              <span>ACCESO PRIVADO</span>
              <h2>Bienvenido</h2>
              <p>Ingresa el código que te proporcionó tu administrador.</p>
            </div>

            <form onSubmit={submit}>
              <label htmlFor="access-code">Código de acceso</label>
              <div className={`code-field ${error ? 'code-field--error' : ''}`}>
                <KeyRound size={19} />
                <input
                  id="access-code"
                  type={showCode ? 'text' : 'password'}
                  value={code}
                  onChange={(event) => { setCode(event.target.value); setError('') }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  autoFocus
                  disabled={loading}
                />
                <button type="button" onClick={() => setShowCode((value) => !value)} aria-label={showCode ? 'Ocultar código' : 'Mostrar código'}>
                  {showCode ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
              {!error && serviceError && <p className="form-error">{serviceError}</p>}
              <button className="primary-button primary-button--wide" type="submit" disabled={loading}>
                <span>{loading ? 'Verificando…' : 'Ingresar a la plataforma'}</span>
                {!loading && <ArrowRight size={18} />}
              </button>
            </form>

            <div className="secure-note"><ShieldCheck size={15} /> Acceso seguro y contenido protegido</div>

          </div>
        </div>
      </section>

      <footer className="login-footer"><span>© 2026 {data.organization}</span><span>Aprende · Crece · Lidera</span></footer>
    </main>
  )
}

const ADMIN_NAV = [
  { id: 'overview', label: 'Resumen', icon: LayoutDashboard },
  { id: 'sections', label: 'Secciones', icon: FolderCog },
  { id: 'videos', label: 'Biblioteca', icon: Video },
  { id: 'settings', label: 'Configuración', icon: Settings2 },
  { id: 'access', label: 'Códigos de acceso', icon: KeyRound },
  { id: 'preview', label: 'Vista por rol', icon: Eye },
]

function AdminApp({
  data,
  setData,
  theme,
  toggleTheme,
  saveState,
  onRetrySave,
  onRotateCodes,
  loggingOut,
  onLogout,
}) {
  const [page, setPage] = useState('overview')
  const [menuOpen, setMenuOpen] = useState(false)

  const navigate = (nextPage) => {
    setPage(nextPage)
    setMenuOpen(false)
  }

  const removeSection = (sectionId) => {
    const sectionName = data.sections.find((section) => section.id === sectionId)?.name || 'esta sección'
    if (!window.confirm(`¿Eliminar ${sectionName}? También se quitarán sus asignaciones de video.`)) return
    setData((current) => ({
      ...current,
      sections: current.sections.filter((section) => section.id !== sectionId),
      videos: current.videos.map((video) => {
        const assignments = Object.fromEntries(Object.entries(video.assignments).filter(([, value]) => value !== sectionId))
        const locked = Object.fromEntries(Object.entries(video.locked || {}).filter(([role]) => assignments[role]))
        return { ...video, assignments, locked }
      }),
    }))
  }

  const titles = {
    overview: ['Resumen general', 'Todo bajo control, en un solo lugar.'],
    sections: ['Secciones y navegación', 'Define lo que aparece en el menú de cada rol.'],
    videos: ['Biblioteca de videos', 'Publica contenido y decide quién puede verlo.'],
    settings: ['Configuración general', 'Personaliza los textos y preferencias de la plataforma.'],
    access: ['Códigos de acceso', 'Administra la entrada independiente de cada rol.'],
    preview: ['Vista por rol', 'Comprueba la experiencia antes de compartirla.'],
  }

  return (
    <div className={`app-layout ${loggingOut ? 'app-layout--busy' : ''}`}>
      {loggingOut && <div className="app-saving-overlay"><span className="loading-spinner" /><strong>Guardando y cerrando sesión…</strong></div>}
      <button className={`mobile-overlay ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" />
      <aside className={`sidebar admin-sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__top">
          <CompanyLogo compact />
          <button className="sidebar-close" onClick={() => setMenuOpen(false)}><X size={20} /></button>
        </div>
        <div className="role-pill"><span>AD</span><div><strong>Administrador</strong><small>Control total</small></div></div>
        <nav className="sidebar-nav" aria-label="Administración">
          <small className="sidebar-label">GESTIÓN</small>
          {ADMIN_NAV.map((item) => {
            const Icon = item.icon
            return (
              <button className={page === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)}>
                <Icon size={19} /><span>{item.label}</span>{page === item.id && <ChevronRight className="nav-chevron" size={15} />}
              </button>
            )
          })}
        </nav>
        <div className="sidebar__bottom">
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          <button className="sidebar-action" onClick={onLogout} disabled={loggingOut}><LogOut size={18} /><span>{loggingOut ? 'Guardando…' : 'Cerrar sesión'}</span></button>
        </div>
      </aside>

      <section className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
          <div className="topbar__title"><small>ADMINISTRACIÓN</small><strong>{titles[page][0]}</strong></div>
          <div className="topbar__right">
            <span className={`status-dot status-dot--${saveState.status}`} title={saveState.error || undefined}>
              <i />
              {saveState.status === 'pending' && 'Cambios pendientes'}
              {saveState.status === 'saving' && 'Guardando en Supabase…'}
              {saveState.status === 'saved' && 'Guardado en Supabase'}
              {saveState.status === 'error' && 'Error al guardar'}
              {saveState.status === 'idle' && 'Conectado a Supabase'}
            </span>
            {saveState.status === 'error' && <button className="save-retry-button" type="button" onClick={onRetrySave}>{saveState.code === 'STALE_SNAPSHOT' ? 'Recargar' : 'Reintentar'}</button>}
            <div className="admin-avatar">AD</div>
          </div>
        </header>
        <main className="content-area">
          <div className="page-heading">
            <div><span className="eyebrow eyebrow--plain">PANEL DE CONTROL</span><h1>{titles[page][0]}</h1><p>{titles[page][1]}</p></div>
          </div>
          {page === 'overview' && <AdminOverview data={data} onNavigate={navigate} />}
          {page === 'sections' && <SectionsManager data={data} setData={setData} onRemove={removeSection} />}
          {page === 'videos' && <VideosManager data={data} setData={setData} />}
          {page === 'settings' && <SettingsManager data={data} setData={setData} />}
          {page === 'access' && <AccessManager onRotateCodes={onRotateCodes} />}
          {page === 'preview' && <RolePreview data={data} />}
          {saveState.status === 'error' && <div className="save-error-banner"><CircleHelp size={17} /><span>{saveState.error}</span><button type="button" onClick={onRetrySave}>{saveState.code === 'STALE_SNAPSHOT' ? 'Recargar desde Supabase' : 'Reintentar'}</button></div>}
        </main>
      </section>
    </div>
  )
}

function SettingsManager({ data, setData }) {
  const settings = data.settings || {
    productName: 'Video Hub',
    welcomeTitle: 'Todo lo que necesitas aprender, en un solo lugar.',
    welcomeMessage: '',
    supportMessage: 'Contacta a tu administrador',
    allowLightMode: true,
  }

  const updateSetting = (key, value) => {
    setData((current) => ({
      ...current,
      settings: { ...settings, ...(current.settings || {}), [key]: value },
    }))
  }

  return (
    <div className="manager-stack">
      <section className="panel settings-panel">
        <div className="panel-heading"><div><h2>Identidad y experiencia</h2><p>Estos cambios se guardan en Supabase y se aplican a las vistas de los roles.</p></div></div>
        <div className="general-settings-form">
          <div className="form-group"><label>Nombre de la organización</label><input value={data.organization || ''} onChange={(event) => setData((current) => ({ ...current, organization: event.target.value }))} maxLength="120" /></div>
          <div className="form-group"><label>Nombre del portal</label><input value={settings.productName} onChange={(event) => updateSetting('productName', event.target.value)} maxLength="80" /></div>
          <div className="form-group general-settings-form__wide"><label>Título de bienvenida</label><input value={settings.welcomeTitle} onChange={(event) => updateSetting('welcomeTitle', event.target.value)} maxLength="180" /></div>
          <div className="form-group general-settings-form__wide"><label>Mensaje de bienvenida</label><textarea value={settings.welcomeMessage} onChange={(event) => updateSetting('welcomeMessage', event.target.value)} rows="4" placeholder="Escribe el mensaje que verán Operante y Jefe." /></div>
          <div className="form-group general-settings-form__wide"><label>Mensaje de ayuda</label><input value={settings.supportMessage} onChange={(event) => updateSetting('supportMessage', event.target.value)} placeholder="Ej. Escribe al administrador" /></div>
          <label className="feature-check general-settings-form__wide"><input type="checkbox" checked={settings.allowLightMode !== false} onChange={(event) => updateSetting('allowLightMode', event.target.checked)} /><span><Sun size={16} /></span><div><strong>Permitir modo claro</strong><small>Los usuarios podrán alternar entre el tema oscuro y claro.</small></div></label>
        </div>
      </section>
      <div className="info-callout"><Settings2 size={19} /><div><strong>Guardado automático</strong><p>El indicador superior confirma cuándo la configuración ya está persistida en Supabase.</p></div></div>
    </div>
  )
}

function AdminOverview({ data, onNavigate }) {
  const visibleSectionIds = (role) => new Set(data.sections.filter((section) => section.roles.includes(role)).map((section) => section.id))
  const operatorSections = visibleSectionIds('operator')
  const bossSections = visibleSectionIds('boss')
  const operatorVideos = data.videos.filter((video) => operatorSections.has(video.assignments.operator)).length
  const bossVideos = data.videos.filter((video) => bossSections.has(video.assignments.boss)).length
  const operatorBlocked = data.videos.filter((video) => operatorSections.has(video.assignments.operator) && isVideoLockedFor(video, 'operator')).length
  const bossBlocked = data.videos.filter((video) => bossSections.has(video.assignments.boss) && isVideoLockedFor(video, 'boss')).length
  const stats = [
    { label: 'Videos publicados', value: data.videos.length, note: 'en la biblioteca', icon: Play, tone: 'gold' },
    { label: 'Secciones activas', value: data.sections.length, note: 'entre ambos roles', icon: Layers3, tone: 'blue' },
    { label: 'Para operante', value: operatorVideos, note: `${operatorVideos - operatorBlocked} disponibles · ${operatorBlocked} bloqueados`, icon: UsersRound, tone: 'green' },
    { label: 'Para jefe', value: bossVideos, note: `${bossVideos - bossBlocked} disponibles · ${bossBlocked} bloqueados`, icon: BriefcaseBusiness, tone: 'violet' },
  ]

  return (
    <div className="admin-overview">
      <div className="stat-grid">
        {stats.map((stat) => {
          const Icon = stat.icon
          return <article className="stat-card" key={stat.label}><div className={`stat-icon stat-icon--${stat.tone}`}><Icon size={20} /></div><div><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.note}</small></div></article>
        })}
      </div>

      <div className="dashboard-grid">
        <section className="panel recent-panel">
          <div className="panel-heading"><div><h2>Contenido reciente</h2><p>Últimos videos agregados</p></div><button className="text-button" onClick={() => onNavigate('videos')}>Ver biblioteca <ArrowRight size={15} /></button></div>
          <div className="recent-list">
            {[...data.videos].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4).map((video) => {
              const source = getPersistedVideoSource(video)
              return (
                <div className="recent-row" key={video.id}>
                  <div className="mini-thumbnail"><VideoThumbnail video={video} /><Play size={16} fill="currentColor" /></div>
                  <div className="recent-row__copy"><strong>{video.title}</strong><small><span style={{ color: getSourceAccent(source.label) }}>{source.label}</span> · {Object.keys(video.assignments).map((role) => ROLE_META[role].label).join(', ')}</small></div>
                  <span className="status-badge">Publicado</span>
                </div>
              )
            })}
          </div>
        </section>

        <aside className="panel quick-panel">
          <div className="panel-heading"><div><h2>Acciones rápidas</h2><p>Configura tu plataforma</p></div></div>
          <button onClick={() => onNavigate('videos')}><span className="quick-icon"><Plus size={18} /></span><div><strong>Agregar video</strong><small>YouTube, Drive, Vimeo o MP4</small></div><ChevronRight size={17} /></button>
          <button onClick={() => onNavigate('sections')}><span className="quick-icon"><FolderCog size={18} /></span><div><strong>Crear sección</strong><small>Ordena el contenido por tema</small></div><ChevronRight size={17} /></button>
          <button onClick={() => onNavigate('preview')}><span className="quick-icon"><Eye size={18} /></span><div><strong>Revisar permisos</strong><small>Vista de operante y jefe</small></div><ChevronRight size={17} /></button>
        </aside>
      </div>

      <section className="access-summary">
        <div className="access-summary__copy"><span className="access-summary__icon"><ShieldCheck size={22} /></span><div><h2>Acceso diferenciado por rol</h2><p>Cada usuario solo accede a las secciones y videos que tú autorizas.</p></div></div>
        <div className="access-bars">
          <div><span><b>Operante</b><small>{operatorVideos} de {data.videos.length} videos</small></span><i><em style={{ width: `${data.videos.length ? (operatorVideos / data.videos.length) * 100 : 0}%` }} /></i></div>
          <div><span><b>Jefe</b><small>{bossVideos} de {data.videos.length} videos</small></span><i><em style={{ width: `${data.videos.length ? (bossVideos / data.videos.length) * 100 : 0}%` }} /></i></div>
        </div>
      </section>
    </div>
  )
}

function SectionsManager({ data, setData, onRemove }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', icon: 'layers', roles: ['operator'] })
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')

  const addSection = (event) => {
    event.preventDefault()
    if (!draft.name.trim() || !draft.roles.length) return
    const section = {
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      icon: draft.icon,
      roles: draft.roles,
      order: data.sections.length,
    }
    setData((current) => ({ ...current, sections: [...current.sections, section] }))
    setDraft({ name: '', icon: 'layers', roles: ['operator'] })
    setAdding(false)
  }

  const toggleRole = (sectionId, role) => {
    setData((current) => ({
      ...current,
      sections: current.sections.map((section) => section.id === sectionId
        ? { ...section, roles: section.roles.includes(role) ? section.roles.filter((item) => item !== role) : [...section.roles, role] }
        : section),
    }))
  }

  const move = (sectionId, direction) => {
    setData((current) => {
      const sorted = [...current.sections].sort((a, b) => a.order - b.order)
      const index = sorted.findIndex((section) => section.id === sectionId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= sorted.length) return current
      ;[sorted[index], sorted[target]] = [sorted[target], sorted[index]]
      return { ...current, sections: sorted.map((section, order) => ({ ...section, order })) }
    })
  }

  const saveName = (id) => {
    if (editingName.trim()) {
      setData((current) => ({ ...current, sections: current.sections.map((section) => section.id === id ? { ...section, name: editingName.trim() } : section) }))
    }
    setEditingId(null)
  }

  const sortedSections = [...data.sections].sort((a, b) => a.order - b.order)

  return (
    <div className="manager-stack">
      <section className="panel manager-panel">
        <div className="manager-toolbar">
          <div><h2>Menú de navegación</h2><p>Activa cada sección para operante, jefe o ambos.</p></div>
          <button className="primary-button" onClick={() => setAdding((value) => !value)}>{adding ? <X size={17} /> : <Plus size={17} />} {adding ? 'Cancelar' : 'Nueva sección'}</button>
        </div>

        {adding && (
          <form className="inline-form" onSubmit={addSection}>
            <div className="form-group grow"><label>Nombre de la sección</label><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ej. Recursos humanos" autoFocus /></div>
            <div className="form-group"><label>Icono</label><select value={draft.icon} onChange={(event) => setDraft({ ...draft, icon: event.target.value })}>{SECTION_ICON_OPTIONS.map((icon) => <option value={icon.value} key={icon.value}>{icon.label}</option>)}</select></div>
            <div className="form-group"><label>Visible para</label><div className="role-checks">{['operator', 'boss'].map((role) => <button type="button" className={draft.roles.includes(role) ? 'selected' : ''} key={role} onClick={() => setDraft({ ...draft, roles: draft.roles.includes(role) ? draft.roles.filter((item) => item !== role) : [...draft.roles, role] })}><Check size={13} /> {ROLE_META[role].label}</button>)}</div></div>
            <button className="primary-button form-submit" type="submit" disabled={!draft.name.trim() || !draft.roles.length}>Crear</button>
          </form>
        )}

        <div className="section-list">
          <div className="section-list__head"><span>Sección</span><span>Visibilidad</span><span>Videos</span><span>Orden</span><span>Acciones</span></div>
          {sortedSections.map((section, index) => {
            const Icon = ICONS[section.icon] || Layers3
            const count = data.videos.filter((video) => Object.values(video.assignments).includes(section.id)).length
            return (
              <div className="section-row" key={section.id}>
                <div className="section-identity"><span className="section-icon"><Icon size={18} /></span>{editingId === section.id ? <div className="inline-edit"><input value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveName(section.id) }} autoFocus /><button onClick={() => saveName(section.id)}><Check size={15} /></button></div> : <div><strong>{section.name}</strong><small>/{section.id.split('-').slice(0, -1).join('-') || section.id}</small></div>}</div>
                <div className="role-toggles">{['operator', 'boss'].map((role) => <button className={section.roles.includes(role) ? 'on' : ''} onClick={() => toggleRole(section.id, role)} key={role}><span>{section.roles.includes(role) && <Check size={11} />}</span>{ROLE_META[role].label}</button>)}</div>
                <span className="count-chip">{count} {count === 1 ? 'video' : 'videos'}</span>
                <div className="order-buttons"><button disabled={index === 0} onClick={() => move(section.id, -1)}><ChevronLeft size={16} /></button><button disabled={index === sortedSections.length - 1} onClick={() => move(section.id, 1)}><ChevronRight size={16} /></button></div>
                <div className="row-actions"><button onClick={() => { setEditingId(section.id); setEditingName(section.name) }}><Pencil size={16} /></button><button className="danger" onClick={() => onRemove(section.id)}><Trash2 size={16} /></button></div>
              </div>
            )
          })}
          {!sortedSections.length && <EmptyState icon={FolderCog} title="Aún no hay secciones" text="Crea la primera sección para organizar tus videos." />}
        </div>
      </section>
      <div className="info-callout"><Lightbulb size={19} /><div><strong>Un menú distinto para cada rol</strong><p>Si desactivas una sección para un rol, desaparecerá por completo de su barra lateral. Los videos asignados allí tampoco serán visibles.</p></div></div>
    </div>
  )
}

const emptyVideoDraft = {
  title: '',
  description: '',
  url: '',
  thumbnailUrl: '',
  duration: '',
  featured: false,
  operatorEnabled: true,
  operatorSection: '',
  operatorLocked: false,
  bossEnabled: false,
  bossSection: '',
  bossLocked: false,
}

function VideosManager({ data, setData }) {
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(emptyVideoDraft)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  const sectionsFor = (role) => [...data.sections].filter((section) => section.roles.includes(role)).sort((a, b) => a.order - b.order)

  const openNew = () => {
    setEditingId(null)
    setError('')
    setDraft({ ...emptyVideoDraft, operatorSection: sectionsFor('operator')[0]?.id || '', bossSection: sectionsFor('boss')[0]?.id || '' })
    setFormOpen(true)
  }

  const openEdit = (video) => {
    setEditingId(video.id)
    setError('')
    setDraft({
      title: video.title,
      description: video.description,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl || '',
      duration: video.duration || '',
      featured: Boolean(video.featured),
      operatorEnabled: Boolean(video.assignments.operator),
      operatorSection: video.assignments.operator || sectionsFor('operator')[0]?.id || '',
      operatorLocked: Boolean(video.locked?.operator),
      bossEnabled: Boolean(video.assignments.boss),
      bossSection: video.assignments.boss || sectionsFor('boss')[0]?.id || '',
      bossLocked: Boolean(video.locked?.boss),
    })
    setFormOpen(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const saveVideo = (event) => {
    event.preventDefault()
    const source = getVideoSource(draft.url)
    if (!draft.title.trim() || !draft.description.trim() || ['empty', 'invalid'].includes(source.type)) {
      setError('Completa el título, la descripción y un enlace de video válido.')
      return
    }
    if ((!draft.operatorEnabled || !draft.operatorSection) && (!draft.bossEnabled || !draft.bossSection)) {
      setError('Asigna el video al menos a un rol y una sección.')
      return
    }
    const assignments = {}
    if (draft.operatorEnabled && draft.operatorSection) assignments.operator = draft.operatorSection
    if (draft.bossEnabled && draft.bossSection) assignments.boss = draft.bossSection
    const locked = {}
    if (draft.operatorEnabled && draft.operatorSection) locked.operator = draft.operatorLocked
    if (draft.bossEnabled && draft.bossSection) locked.boss = draft.bossLocked
    const payload = {
      title: draft.title.trim(),
      description: draft.description.trim(),
      url: draft.url.trim(),
      thumbnailUrl: draft.thumbnailUrl.trim(),
      duration: draft.duration.trim() || 'Video',
      featured: draft.featured,
      assignments,
      locked,
    }
    setData((current) => editingId
      ? { ...current, videos: current.videos.map((video) => video.id === editingId ? { ...video, ...payload } : video) }
      : { ...current, videos: [{ ...payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...current.videos] })
    setFormOpen(false)
    setEditingId(null)
    setDraft(emptyVideoDraft)
  }

  const deleteVideo = (id) => {
    const videoTitle = data.videos.find((video) => video.id === id)?.title || 'este video'
    if (!window.confirm(`¿Eliminar “${videoTitle}” de Supabase?`)) return
    setData((current) => ({ ...current, videos: current.videos.filter((video) => video.id !== id) }))
  }
  const source = getVideoSource(draft.url)
  const filtered = data.videos.filter((video) => video.title.toLowerCase().includes(query.toLowerCase()))
  const groupOrder = ['operator', 'boss', 'both']
  if (filtered.some((video) => getVideoAudience(video) === 'none')) groupOrder.push('none')
  const libraryGroups = groupOrder.map((audience) => ({
    id: audience,
    ...AUDIENCE_META[audience],
    videos: filtered.filter((video) => getVideoAudience(video) === audience),
  }))
  const visibleLibraryGroups = query.trim() ? libraryGroups.filter((group) => group.videos.length) : libraryGroups

  return (
    <div className="manager-stack">
      {formOpen && (
        <section className="panel video-form-panel">
          <div className="manager-toolbar"><div><span className="eyebrow eyebrow--plain">{editingId ? 'EDITAR CONTENIDO' : 'NUEVO CONTENIDO'}</span><h2>{editingId ? 'Actualizar video' : 'Agregar un video'}</h2></div><button className="icon-button" onClick={() => setFormOpen(false)}><X size={19} /></button></div>
          <form className="video-form" onSubmit={saveVideo}>
            <div className="video-form__main">
              <div className="form-group"><label>Título del video</label><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Ej. Procedimiento de apertura" maxLength="180" /></div>
              <div className="form-group"><label>Descripción</label><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Explica brevemente qué aprenderá la persona…" rows="4" /></div>
              <div className="form-group"><label>Enlace del video</label><div className="url-input"><UploadCloud size={18} /><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="Pega un enlace de YouTube, Google Drive, Vimeo o MP4" maxLength="2048" /></div>{draft.url && <small className={`source-detection source-detection--${source.type}`}><i style={{ background: getSourceAccent(source.label) }} /> {source.label}</small>}<small>En Google Drive, configura el archivo como “Cualquier persona con el enlace”.</small></div>
              <div className="thumbnail-config">
                <div className="form-group"><label>Miniatura personalizada <span>(opcional)</span></label><div className="url-input"><ImageIcon size={18} /><input value={draft.thumbnailUrl} onChange={(event) => setDraft({ ...draft, thumbnailUrl: event.target.value })} placeholder="Se obtiene automáticamente; pega una imagen solo si quieres reemplazarla" maxLength="2048" /></div><small>Drive y los archivos directos muestran el fotograma del segundo 4. YouTube, Vimeo y Loom usan la imagen del proveedor.</small></div>
                <div className="thumbnail-preview"><VideoThumbnail video={{ title: draft.title || 'Vista previa', url: draft.url, thumbnailUrl: draft.thumbnailUrl }} /><span><ImageIcon size={18} /></span><small>VISTA PREVIA</small></div>
              </div>
              <div className="form-row"><div className="form-group"><label>Duración (opcional)</label><input value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value })} placeholder="Ej. 05:30" maxLength="20" /></div><label className="feature-check"><input type="checkbox" checked={draft.featured} onChange={(event) => setDraft({ ...draft, featured: event.target.checked })} /><span><Sparkles size={16} /></span><div><strong>Video destacado</strong><small>Aparecerá primero en el inicio</small></div></label></div>
            </div>
            <div className="assignment-box">
              <div><h3>Permisos y ubicación</h3><p>Elige exactamente quién lo verá y dónde aparecerá.</p></div>
              {['operator', 'boss'].map((role) => {
                const enabledKey = role === 'operator' ? 'operatorEnabled' : 'bossEnabled'
                const sectionKey = role === 'operator' ? 'operatorSection' : 'bossSection'
                const lockedKey = role === 'operator' ? 'operatorLocked' : 'bossLocked'
                const enabled = draft[enabledKey]
                return (
                  <div className={`assignment-card ${enabled ? 'enabled' : ''}`} key={role}>
                    <label className="switch-line"><span className="role-avatar">{ROLE_META[role].short}</span><div><strong>{ROLE_META[role].label}</strong><small>{enabled ? 'Puede ver este video' : 'Sin acceso'}</small></div><input type="checkbox" checked={enabled} onChange={(event) => setDraft({ ...draft, [enabledKey]: event.target.checked })} /><i /></label>
                    {enabled && <><div className="form-group"><label>Mostrar en la sección</label><select value={draft[sectionKey]} onChange={(event) => setDraft({ ...draft, [sectionKey]: event.target.value })}><option value="">Seleccionar…</option>{sectionsFor(role).map((section) => <option value={section.id} key={section.id}>{section.name}</option>)}</select></div><label className={`role-lock-toggle ${draft[lockedKey] ? 'is-locked' : ''}`}><input type="checkbox" checked={draft[lockedKey]} onChange={(event) => setDraft({ ...draft, [lockedKey]: event.target.checked })} /><span><LockKeyhole size={15} /></span><div><strong>Mostrar como bloqueado</strong><small>Verá la tarjeta, pero no podrá reproducir el video.</small></div><i /></label></>}
                  </div>
                )
              })}
            </div>
            {error && <p className="form-error form-error--box">{error}</p>}
            <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancelar</button><button className="primary-button" type="submit"><Check size={17} /> {editingId ? 'Guardar cambios' : 'Publicar video'}</button></div>
          </form>
        </section>
      )}

      <section className="panel manager-panel">
        <div className="manager-toolbar">
          <div><h2>Biblioteca organizada</h2><p>{data.videos.length} contenidos clasificados por audiencia</p></div>
          <div className="toolbar-actions"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar video…" /></label><button className="primary-button" onClick={openNew}><Plus size={17} /> Agregar video</button></div>
        </div>
        <div className="video-library-groups">
          {visibleLibraryGroups.map((group) => (
            <section className={`video-role-group video-role-group--${group.id}`} key={group.id}>
              <header className="video-role-group__header">
                <div className="video-role-group__title"><span>{group.id === 'both' ? <UsersRound size={16} /> : group.id === 'none' ? <MoreHorizontal size={16} /> : ROLE_META[group.id].short}</span><div><h3>{group.groupLabel}</h3><small>{group.description}</small></div></div>
                <span className="video-role-group__count">{group.videos.length} {group.videos.length === 1 ? 'video' : 'videos'}</span>
                <i className="video-role-group__rule" />
              </header>
              {group.videos.length ? <div className="video-admin-grid video-admin-grid--group">{group.videos.map((video) => <AdminVideoCard video={video} data={data} onEdit={() => openEdit(video)} onDelete={() => deleteVideo(video.id)} key={video.id} />)}</div> : <div className="video-role-group__empty"><Film size={17} /><span>Aún no hay videos en este grupo.</span></div>}
            </section>
          ))}
          {!filtered.length && query && <EmptyState icon={Search} title="No encontramos videos" text="Prueba con otra búsqueda." />}
        </div>
      </section>
    </div>
  )
}

function AdminVideoCard({ video, data, onEdit, onDelete }) {
  const source = getPersistedVideoSource(video)
  const audience = getVideoAudience(video)
  const audienceMeta = AUDIENCE_META[audience]
  const lockedRoles = VIEWER_ROLES.filter((role) => isVideoLockedFor(video, role))
  const getSection = (id) => data.sections.find((section) => section.id === id)?.name || 'Sin sección'
  return (
    <article className="admin-video-card">
      <div className="admin-video-card__visual">
        <VideoThumbnail video={video} />
        <span className="source-badge"><i style={{ background: getSourceAccent(source.label) }} /> {source.label}</span>
        <span className={`audience-badge audience-badge--${audience}`}><UsersRound size={11} /> {audienceMeta.label}</span>
        <span className="play-orb"><Play size={20} fill="currentColor" /></span>
        {!!lockedRoles.length && <span className="role-lock-statuses">{lockedRoles.map((role) => <span className="role-lock-status" key={role}><LockKeyhole size={9} /> {ROLE_META[role].short} bloqueado</span>)}</span>}
        <small>{video.duration}</small>
      </div>
      <div className="admin-video-card__body"><div className="card-title-row"><h3>{video.title}</h3>{video.featured && <Sparkles size={15} />}</div><p>{video.description}</p><div className="assignment-tags">{Object.entries(video.assignments).map(([role, sectionId]) => <span className={isVideoLockedFor(video, role) ? 'is-locked' : ''} key={role}><b>{ROLE_META[role].short}</b>{getSection(sectionId)}{isVideoLockedFor(video, role) && <LockKeyhole size={10} />}</span>)}</div></div>
      <div className="admin-video-card__actions"><button onClick={onEdit}><Pencil size={15} /> Editar</button><button className="danger" onClick={onDelete}><Trash2 size={15} /></button></div>
    </article>
  )
}

function AccessManager({ onRotateCodes }) {
  const [codes, setCodes] = useState({ admin: '', operator: '', boss: '' })
  const [visible, setVisible] = useState({})
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (event) => {
    event.preventDefault()
    const normalizedEntries = Object.entries(codes).map(([role, code]) => [role, code.trim().toUpperCase()])
    const normalizedCodes = Object.fromEntries(normalizedEntries)
    const values = Object.values(normalizedCodes)
    if (values.some((code) => code.length < 8 || code.length > 128)) {
      setError('Cada código nuevo debe tener entre 8 y 128 caracteres.')
      return
    }
    if (new Set(values).size !== values.length) {
      setError('Cada rol debe tener un código diferente.')
      return
    }
    setError('')
    setSaving(true)
    try {
      await onRotateCodes(normalizedCodes)
      setCodes({ admin: '', operator: '', boss: '' })
      setVisible({})
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2600)
    } catch (saveError) {
      setError(getErrorMessage(saveError, 'No se pudieron actualizar los códigos.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="access-layout">
      <form className="panel access-panel" onSubmit={save}>
        <div className="panel-heading"><div><h2>Claves por perfil</h2><p>Usa un código diferente y difícil de adivinar para cada tipo de acceso.</p></div></div>
        <div className="code-cards">
          {Object.keys(ROLE_META).map((role) => (
            <div className={`code-card code-card--${role}`} key={role}>
              <div className="code-card__role"><span>{ROLE_META[role].short}</span><div><strong>{ROLE_META[role].label}</strong><small>{role === 'admin' ? 'Configuración total' : role === 'operator' ? 'Contenido operativo' : 'Contenido de liderazgo'}</small></div></div>
              <label>Nuevo código</label>
              <div className="code-editor"><input type={visible[role] ? 'text' : 'password'} value={codes[role]} onChange={(event) => { setCodes({ ...codes, [role]: event.target.value }); setError(''); setSaved(false) }} autoComplete="new-password" disabled={saving} /><button type="button" onClick={() => setVisible({ ...visible, [role]: !visible[role] })} disabled={saving}>{visible[role] ? <EyeOff size={17} /> : <Eye size={17} />}</button><button type="button" onClick={() => navigator.clipboard?.writeText(codes[role])} disabled={!codes[role] || saving}><Copy size={17} /></button></div>
              <small className="code-rule">Entre 8 y 128 caracteres · Recomendamos 16 o más</small>
            </div>
          ))}
        </div>
        {error && <p className="form-error form-error--box access-error">{error}</p>}
        <div className="form-actions"><span className={`saved-message ${saved ? 'show' : ''}`}><Check size={15} /> Códigos actualizados</span><button className="primary-button" type="submit" disabled={saving}><ShieldCheck size={17} /> {saving ? 'Actualizando…' : 'Actualizar los tres códigos'}</button></div>
      </form>
      <aside className="security-card"><span><LockKeyhole size={22} /></span><h3>Seguridad activa</h3><p>Por seguridad, los códigos actuales no se pueden consultar. Al guardar se actualizan las cuentas de acceso y sus huellas protegidas en Supabase.</p><ul><li><Check size={14} /> Códigos fuera del frontend</li><li><Check size={14} /> Sesiones administradas por Supabase</li><li><Check size={14} /> Permisos RLS por rol</li></ul></aside>
    </div>
  )
}

function RolePreview({ data }) {
  const [role, setRole] = useState('operator')
  const [activeSection, setActiveSection] = useState('home')
  const [selectedVideo, setSelectedVideo] = useState(null)
  const [query, setQuery] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  useEffect(() => {
    if (!selectedVideo) return
    const freshVideo = data.videos.find((video) => video.id === selectedVideo.id)
    if (!freshVideo || !isVideoAssignedTo(freshVideo, role) || isVideoLockedFor(freshVideo, role)) {
      setSelectedVideo(null)
    } else if (freshVideo !== selectedVideo) {
      setSelectedVideo(freshVideo)
    }
  }, [data.videos, role, selectedVideo])
  const sections = useMemo(() => [...data.sections].filter((section) => section.roles.includes(role)).sort((a, b) => a.order - b.order), [data.sections, role])
  const visibleSectionIds = new Set(sections.map((section) => section.id))
  const videos = data.videos.filter((video) => visibleSectionIds.has(video.assignments[role]))
  const blockedVideos = videos.filter((video) => isVideoLockedFor(video, role))
  const availableVideos = videos.filter((video) => !isVideoLockedFor(video, role))
  const activeSectionData = sections.find((section) => section.id === activeSection)
  const featured = availableVideos.find((video) => video.featured) || availableVideos[0]
  const filtered = videos.filter((video) => {
    const belongs = activeSection === 'home' || video.assignments[role] === activeSection
    const matches = `${video.title} ${video.description}`.toLowerCase().includes(query.toLowerCase())
    return belongs && matches
  })

  const resetPreview = () => {
    setActiveSection('home')
    setSelectedVideo(null)
    setQuery('')
    setNavOpen(false)
  }

  const switchRole = (nextRole) => {
    setRole(nextRole)
    resetPreview()
  }

  const navigate = (sectionId) => {
    setActiveSection(sectionId)
    setSelectedVideo(null)
    setNavOpen(false)
  }

  const openVideo = (video) => {
    if (!video || isVideoLockedFor(video, role)) return
    setSelectedVideo(video)
  }

  return (
    <div className="manager-stack">
      <section className="preview-switcher"><div><span>Visualizando como</span><strong>{ROLE_META[role].label} · {availableVideos.length} disponibles · {blockedVideos.length} bloqueados</strong></div><div>{['operator', 'boss'].map((item) => <button className={item === role ? 'active' : ''} onClick={() => switchRole(item)} key={item}>{ROLE_META[item].short} {ROLE_META[item].label}</button>)}</div></section>
      <section className="panel role-preview-frame">
        <header className="role-preview-chrome"><div aria-hidden="true"><i /><i /><i /></div><span><Eye size={13} /> Vista interactiva: navega como lo haría este rol</span><button type="button" onClick={resetPreview}><Home size={14} /> Reiniciar vista</button></header>
        <div className="role-preview-app">
          <button className={`role-preview-overlay ${navOpen ? 'is-visible' : ''}`} onClick={() => setNavOpen(false)} aria-label="Cerrar menú de la vista previa" />
          <aside className={`role-preview-sidebar ${navOpen ? 'is-open' : ''}`}>
            <div className="role-preview-brand"><CompanyLogo compact /></div>
            <nav className="sidebar-nav viewer-nav">
              <small className="sidebar-label">EXPLORAR</small>
              <button className={activeSection === 'home' ? 'active' : ''} onClick={() => navigate('home')}><Home size={18} /><span>Inicio</span></button>
              <small className="sidebar-label sidebar-label--spaced">MI CONTENIDO</small>
              {sections.map((section) => { const Icon = ICONS[section.icon] || Layers3; return <button className={activeSection === section.id ? 'active' : ''} onClick={() => navigate(section.id)} key={section.id}><Icon size={18} /><span>{section.name}</span><small>{videos.filter((video) => video.assignments[role] === section.id).length}</small></button> })}
            </nav>
            <div className="sidebar-help"><span><CircleHelp size={16} /></span><div><strong>¿Necesitas ayuda?</strong><small>{data.settings?.supportMessage || 'Contacta a tu administrador'}</small></div></div>
            <div className="role-preview-sidebar-foot"><Eye size={15} /> Vista simulada</div>
          </aside>

          <section className="role-preview-main">
            <header className="role-preview-topbar">
              <button className="role-preview-menu" onClick={() => setNavOpen(true)} aria-label="Abrir menú de la vista previa"><Menu size={19} /></button>
              <label className="global-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedVideo(null) }} placeholder="Buscar en tus videos…" /></label>
              <div className="viewer-profile"><div><span>Bienvenido</span><strong>{ROLE_META[role].label}</strong></div><span className="role-avatar">{ROLE_META[role].short}</span></div>
            </header>
            <main className="role-preview-content">
              {selectedVideo ? (
                <VideoPlayerPage video={selectedVideo} role={role} data={data} onBack={() => setSelectedVideo(null)} onPlay={openVideo} />
              ) : activeSection === 'home' && !query ? (
                <ViewerHome role={role} settings={data.settings} videos={videos} sections={sections} featured={featured} lockedCount={blockedVideos.length} onPlay={openVideo} onSection={navigate} />
              ) : (
                <VideoListing role={role} title={activeSection === 'home' ? 'Resultados de búsqueda' : activeSectionData?.name || 'Videos'} subtitle={query ? `Resultados para “${query}”` : 'Contenido seleccionado para este perfil'} videos={filtered} onPlay={openVideo} />
              )}
            </main>
          </section>
        </div>
      </section>
      <div className="info-callout"><Eye size={19} /><div><strong>Simulación fiel y segura</strong><p>Puedes usar el menú, el buscador, las categorías y los videos. Esta simulación no modifica permisos ni datos; solo reproduce la experiencia del rol seleccionado.</p></div></div>
    </div>
  )
}

function ViewerApp({ role, data, theme, toggleTheme, onLogout }) {
  const sections = useMemo(() => [...data.sections].filter((section) => section.roles.includes(role)).sort((a, b) => a.order - b.order), [data.sections, role])
  const targetedVideos = useMemo(() => {
    const visibleSectionIds = new Set(sections.map((section) => section.id))
    return data.videos.filter((video) => visibleSectionIds.has(video.assignments[role]))
  }, [data.videos, role, sections])
  const playableVideos = useMemo(() => targetedVideos.filter((video) => !isVideoLockedFor(video, role)), [role, targetedVideos])
  const [activeSection, setActiveSection] = useState('home')
  const [selectedVideo, setSelectedVideo] = useState(null)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!selectedVideo) return
    const freshVideo = data.videos.find((video) => video.id === selectedVideo.id)
    if (!freshVideo || !isVideoAssignedTo(freshVideo, role) || isVideoLockedFor(freshVideo, role)) {
      setSelectedVideo(null)
    } else if (freshVideo !== selectedVideo) {
      setSelectedVideo(freshVideo)
    }
  }, [data.videos, role, selectedVideo])

  const openVideo = (video) => {
    if (!video || isVideoLockedFor(video, role)) return
    setSelectedVideo(video)
  }

  const navigate = (sectionId) => {
    setActiveSection(sectionId)
    setSelectedVideo(null)
    setMenuOpen(false)
  }

  const filtered = targetedVideos.filter((video) => {
    const belongs = activeSection === 'home' || video.assignments[role] === activeSection
    const matches = `${video.title} ${video.description}`.toLowerCase().includes(query.toLowerCase())
    return belongs && matches
  })

  const activeSectionData = sections.find((section) => section.id === activeSection)
  const featured = playableVideos.find((video) => video.featured) || playableVideos[0]
  const lockedCount = targetedVideos.filter((video) => isVideoLockedFor(video, role)).length

  return (
    <div className="app-layout viewer-layout">
      <button className={`mobile-overlay ${menuOpen ? 'is-visible' : ''}`} onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" />
      <aside className={`sidebar viewer-sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__top"><CompanyLogo compact /><button className="sidebar-close" onClick={() => setMenuOpen(false)}><X size={20} /></button></div>
        <nav className="sidebar-nav viewer-nav">
          <small className="sidebar-label">EXPLORAR</small>
          <button className={activeSection === 'home' ? 'active' : ''} onClick={() => navigate('home')}><Home size={19} /><span>Inicio</span></button>
          <small className="sidebar-label sidebar-label--spaced">MI CONTENIDO</small>
          {sections.map((section) => { const Icon = ICONS[section.icon] || Layers3; return <button className={activeSection === section.id ? 'active' : ''} onClick={() => navigate(section.id)} key={section.id}><Icon size={19} /><span>{section.name}</span><small>{targetedVideos.filter((video) => video.assignments[role] === section.id).length}</small></button> })}
        </nav>
        <div className="sidebar-help"><span><CircleHelp size={17} /></span><div><strong>¿Necesitas ayuda?</strong><small>{data.settings?.supportMessage || 'Contacta a tu administrador'}</small></div></div>
        <div className="sidebar__bottom">{data.settings?.allowLightMode !== false && <ThemeToggle theme={theme} onToggle={toggleTheme} />}<button className="sidebar-action" onClick={onLogout}><LogOut size={18} /><span>Cerrar sesión</span></button></div>
      </aside>

      <section className="main-shell viewer-main">
        <header className="topbar viewer-topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
          <label className="global-search"><Search size={18} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedVideo(null) }} placeholder="Buscar en tus videos…" /></label>
          <div className="viewer-profile"><div><span>Bienvenido</span><strong>{ROLE_META[role].label}</strong></div><span className="role-avatar">{ROLE_META[role].short}</span></div>
        </header>

        <main className="content-area viewer-content">
          {selectedVideo ? (
            <VideoPlayerPage video={selectedVideo} role={role} data={data} onBack={() => setSelectedVideo(null)} onPlay={openVideo} />
          ) : activeSection === 'home' && !query ? (
            <ViewerHome role={role} settings={data.settings} videos={targetedVideos} sections={sections} featured={featured} lockedCount={lockedCount} onPlay={openVideo} onSection={navigate} />
          ) : (
            <VideoListing role={role} title={activeSection === 'home' ? 'Resultados de búsqueda' : activeSectionData?.name || 'Videos'} subtitle={query ? `Resultados para “${query}”` : 'Contenido seleccionado para tu perfil'} videos={filtered} onPlay={openVideo} />
          )}
        </main>
      </section>
    </div>
  )
}

function ViewerHome({ role, settings, videos, sections, featured, lockedCount, onPlay, onSection }) {
  const recent = [...videos].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const availableCount = videos.length - lockedCount
  return (
    <div className="viewer-home">
      <div className="viewer-welcome"><div><span className="eyebrow"><Sparkles size={14} /> {settings?.productName || 'TU ESPACIO DE APRENDIZAJE'}</span><h1>{settings?.welcomeTitle || <>Hola, <em>{ROLE_META[role].label}</em></>}</h1><p>{settings?.welcomeMessage || 'Continúa aprendiendo con el contenido preparado para ti.'}</p></div><div className="viewer-date"><Clock3 size={17} /><span>Contenido actualizado</span></div></div>
      {featured && (
        <section className="hero-video">
          <VideoThumbnail video={featured} className="hero-video__media" />
          <div className="hero-video__texture" />
          <div className="hero-video__copy"><span className="featured-label"><Sparkles size={13} /> DESTACADO</span><h2>{featured.title}</h2><p>{featured.description}</p><div><button className="light-button" onClick={() => onPlay(featured)}><Play size={17} fill="currentColor" /> Reproducir ahora</button><span><Clock3 size={15} /> {featured.duration}</span></div></div>
          <button className="hero-video__play" onClick={() => onPlay(featured)} aria-label={`Reproducir ${featured.title}`}><Play size={28} fill="currentColor" /></button>
        </section>
      )}
      <div className="viewer-section-heading"><div><span className="eyebrow eyebrow--plain">RECIENTES</span><h2>Continúa explorando</h2></div><span>{availableCount} disponibles{lockedCount ? ` · ${lockedCount} bloqueados` : ''}</span></div>
      <div className="viewer-video-grid">{recent.slice(0, 6).map((video) => <ViewerVideoCard role={role} video={video} section={sections.find((item) => item.id === video.assignments[role])} onPlay={() => onPlay(video)} key={video.id} />)}</div>
      {!videos.length && <EmptyState icon={Film} title="Todavía no hay contenido" text="El administrador aún no ha habilitado videos para tu perfil." />}
      <section className="category-strip"><div className="viewer-section-heading"><div><span className="eyebrow eyebrow--plain">SECCIONES</span><h2>Explora por categoría</h2></div></div><div className="category-grid">{sections.map((section) => { const Icon = ICONS[section.icon] || Layers3; const count = videos.filter((video) => video.assignments[role] === section.id).length; return <button onClick={() => onSection(section.id)} key={section.id}><span><Icon size={20} /></span><div><strong>{section.name}</strong><small>{count} {count === 1 ? 'video' : 'videos'}</small></div><ChevronRight size={17} /></button> })}</div></section>
      {lockedCount > 0 && <div className="locked-notice"><LockKeyhole size={18} /><div><strong>Contenido bloqueado por el administrador</strong><p>{lockedCount} {lockedCount === 1 ? 'video aparece bloqueado' : 'videos aparecen bloqueados'} en tu biblioteca. Puedes identificarlos, pero no abrirlos ni reproducirlos.</p></div></div>}
    </div>
  )
}

function VideoListing({ role, title, subtitle, videos, onPlay }) {
  return (
    <div>
      <div className="listing-heading"><span className="eyebrow eyebrow--plain">BIBLIOTECA</span><h1>{title}</h1><p>{subtitle}</p></div>
      <div className="viewer-video-grid">{videos.map((video) => <ViewerVideoCard role={role} video={video} onPlay={() => onPlay(video)} key={video.id} />)}</div>
      {!videos.length && <EmptyState icon={Search} title="No hay resultados" text="No encontramos videos con esos criterios." />}
    </div>
  )
}

function ViewerVideoCard({ role, video, section, onPlay }) {
  const locked = isVideoLockedFor(video, role)
  const source = locked ? null : getPersistedVideoSource(video)
  const handlePlay = (event) => {
    event.stopPropagation()
    if (!locked) onPlay()
  }
  return (
    <article className={`viewer-video-card ${locked ? 'viewer-video-card--locked' : ''}`} onClick={locked ? undefined : onPlay} aria-disabled={locked}>
      <div className="viewer-video-card__visual">{!locked && <VideoThumbnail video={video} />}{source && <span className="source-badge"><i style={{ background: getSourceAccent(source.label) }} />{source.label}</span>}{locked ? <div className="viewer-video-card__lock"><span><LockKeyhole size={19} /></span><strong>Video bloqueado</strong></div> : <button type="button" onClick={handlePlay} aria-label={`Reproducir ${video.title}`}><Play size={19} fill="currentColor" /></button>}<small>{video.duration}</small></div>
      <div className="viewer-video-card__body">{section && <span>{section.name}</span>}<h3>{video.title}</h3><p>{locked ? 'El administrador mantiene este contenido bloqueado para tu rol.' : video.description}</p><button type="button" disabled={locked} onClick={handlePlay}>{locked ? <><LockKeyhole size={13} /> Contenido bloqueado</> : <>Ver video <ArrowRight size={14} /></>}</button></div>
    </article>
  )
}

function VideoPlayerMedia({ source, title }) {
  const frameClassName = source.provider === 'google_drive'
    ? 'video-frame video-frame--google-drive'
    : 'video-frame'

  return (
    <div className={frameClassName} data-player-mode={source.type}>
      {source.type === 'video' ? (
        <video src={source.embedUrl} controls preload="metadata" playsInline />
      ) : source.type === 'iframe' ? (
        <iframe src={source.embedUrl} title={title} referrerPolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />
      ) : (
        <div className="video-error"><Film size={32} /><p>No se pudo cargar este enlace.</p></div>
      )}
    </div>
  )
}

function VideoPlayerPage({ video, role, data, onBack, onPlay }) {
  if (!isVideoAssignedTo(video, role) || isVideoLockedFor(video, role)) {
    return <div className="player-page"><button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Volver a la biblioteca</button><div className="player-blocked-state"><span><LockKeyhole size={28} /></span><h2>Este video está bloqueado</h2><p>El administrador no ha habilitado su reproducción para tu rol.</p></div></div>
  }
  const source = getPersistedVideoSource(video)
  const section = data.sections.find((item) => item.id === video.assignments[role])
  const related = data.videos.filter((item) => item.id !== video.id && item.assignments[role] === video.assignments[role] && !isVideoLockedFor(item, role)).slice(0, 3)
  return (
    <div className="player-page">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Volver a la biblioteca</button>
      <div className="player-layout">
        <div>
          <VideoPlayerMedia source={source} title={video.title} />
          <div className="player-copy"><div className="player-meta"><span>{section?.name || 'Video'}</span><span><i style={{ background: getSourceAccent(source.label) }} />{source.label}</span><span><Clock3 size={14} /> {video.duration}</span></div><h1>{video.title}</h1><p>{video.description}</p></div>
        </div>
        <aside className="related-panel"><span className="eyebrow eyebrow--plain">A CONTINUACIÓN</span><h3>En esta sección</h3>{related.map((item) => <button key={item.id} onClick={() => onPlay(item)}><span><Play size={13} fill="currentColor" /></span><div><strong>{item.title}</strong><small>{item.duration}</small></div></button>)}{!related.length && <p>No hay más videos en esta sección.</p>}<div className="privacy-mini"><ShieldCheck size={17} /><span>Contenido autorizado para {ROLE_META[role].label}</span></div></aside>
      </div>
    </div>
  )
}

function EmptyState({ icon: Icon, title, text }) {
  return <div className="empty-state"><span><Icon size={24} /></span><h3>{title}</h3><p>{text}</p></div>
}

export default App
