import { useEffect, useMemo, useState } from 'react'
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
import { createDefaultData, DEFAULT_CODES, ROLE_META } from './data'
import { getSourceAccent, getVideoSource, resolveVideoThumbnail } from './videoUtils'

const STORAGE_KEY = 'aurea-video-hub-data-v1'
const THEME_KEY = 'aurea-video-hub-theme'

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

function readData() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return createDefaultData()

    const parsed = JSON.parse(saved)
    const updatedDemoUrls = {
      'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4': 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
      'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4': 'https://www.w3schools.com/html/mov_bbb.mp4',
      'https://vimeo.com/76979871': 'https://vimeo.com/863362136',
    }

    return {
      ...parsed,
      organization: parsed.organization === 'Aurea' ? 'Almacén de Remates' : parsed.organization,
      videos: (parsed.videos || []).map((video) => {
        const assignments = video.assignments || {}
        const locked = Object.fromEntries(
          VIEWER_ROLES
            .filter((role) => assignments[role])
            .map((role) => [role, Boolean(video.locked?.[role])]),
        )

        return {
          ...video,
          assignments,
          locked,
          url: updatedDemoUrls[video.url] || video.url,
        }
      }),
    }
  } catch {
    return createDefaultData()
  }
}

function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark')
  const [data, setData] = useState(readData)
  const [session, setSession] = useState(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])

  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  const loginWithCode = (code) => {
    const cleanCode = code.trim().toUpperCase()
    const role = Object.entries(data.codes).find(([, savedCode]) => savedCode.toUpperCase() === cleanCode)?.[0]
    if (!role) return false
    setSession({ role, signedInAt: Date.now() })
    return true
  }

  if (!session) {
    return <LoginScreen data={data} theme={theme} toggleTheme={toggleTheme} onLogin={loginWithCode} />
  }

  if (session.role === 'admin') {
    return (
      <AdminApp
        data={data}
        setData={setData}
        theme={theme}
        toggleTheme={toggleTheme}
        onLogout={() => setSession(null)}
      />
    )
  }

  return (
    <ViewerApp
      role={session.role}
      data={data}
      theme={theme}
      toggleTheme={toggleTheme}
      onLogout={() => setSession(null)}
    />
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
  const source = getVideoSource(video?.url || '')
  const preferredThumbnail = video?.thumbnailUrl?.trim() || source.thumbnailUrl || ''
  const [thumbnailUrl, setThumbnailUrl] = useState(preferredThumbnail)
  const [videoFailed, setVideoFailed] = useState(false)

  useEffect(() => {
    let active = true
    setThumbnailUrl(preferredThumbnail)
    setVideoFailed(false)

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
    const frameUrl = source.embedUrl.includes('#') ? source.embedUrl : `${source.embedUrl}#t=0.1`
    return (
      <video
        className={`video-thumbnail-media ${className}`}
        src={frameUrl}
        preload="metadata"
        muted
        playsInline
        aria-label={`Miniatura de ${video.title || 'video'}`}
        onError={() => setVideoFailed(true)}
      />
    )
  }

  return null
}

function LoginScreen({ data, theme, toggleTheme, onLogin }) {
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = (event) => {
    event.preventDefault()
    setError('')
    if (!code.trim()) {
      setError('Escribe tu código de acceso para continuar.')
      return
    }
    setLoading(true)
    window.setTimeout(() => {
      const accepted = onLogin(code)
      if (!accepted) {
        setError('El código no es válido. Compruébalo e inténtalo nuevamente.')
        setLoading(false)
      }
    }, 420)
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
                />
                <button type="button" onClick={() => setShowCode((value) => !value)} aria-label={showCode ? 'Ocultar código' : 'Mostrar código'}>
                  {showCode ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
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
  { id: 'access', label: 'Códigos de acceso', icon: KeyRound },
  { id: 'preview', label: 'Vista por rol', icon: Eye },
]

function AdminApp({ data, setData, theme, toggleTheme, onLogout }) {
  const [page, setPage] = useState('overview')
  const [menuOpen, setMenuOpen] = useState(false)

  const navigate = (nextPage) => {
    setPage(nextPage)
    setMenuOpen(false)
  }

  const removeSection = (sectionId) => {
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
    access: ['Códigos de acceso', 'Administra la entrada independiente de cada rol.'],
    preview: ['Vista por rol', 'Comprueba la experiencia antes de compartirla.'],
  }

  return (
    <div className="app-layout">
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
          <button className="sidebar-action" onClick={onLogout}><LogOut size={18} /><span>Cerrar sesión</span></button>
        </div>
      </aside>

      <section className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
          <div className="topbar__title"><small>ADMINISTRACIÓN</small><strong>{titles[page][0]}</strong></div>
          <div className="topbar__right">
            <span className="status-dot"><i /> Sistema activo</span>
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
          {page === 'access' && <AccessManager data={data} setData={setData} />}
          {page === 'preview' && <RolePreview data={data} />}
        </main>
      </section>
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
              const source = getVideoSource(video.url)
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
      id: `${draft.name.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`,
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
    const sorted = [...data.sections].sort((a, b) => a.order - b.order)
    const index = sorted.findIndex((section) => section.id === sectionId)
    const target = index + direction
    if (target < 0 || target >= sorted.length) return
    ;[sorted[index], sorted[target]] = [sorted[target], sorted[index]]
    setData((current) => ({ ...current, sections: sorted.map((section, order) => ({ ...section, order })) }))
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
      : { ...current, videos: [{ ...payload, id: `video-${Date.now().toString(36)}`, createdAt: new Date().toISOString() }, ...current.videos] })
    setFormOpen(false)
    setEditingId(null)
    setDraft(emptyVideoDraft)
  }

  const deleteVideo = (id) => setData((current) => ({ ...current, videos: current.videos.filter((video) => video.id !== id) }))
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
              <div className="form-group"><label>Título del video</label><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Ej. Procedimiento de apertura" /></div>
              <div className="form-group"><label>Descripción</label><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Explica brevemente qué aprenderá la persona…" rows="4" /></div>
              <div className="form-group"><label>Enlace del video</label><div className="url-input"><UploadCloud size={18} /><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="Pega un enlace de YouTube, Google Drive, Vimeo o MP4" /></div>{draft.url && <small className={`source-detection source-detection--${source.type}`}><i style={{ background: getSourceAccent(source.label) }} /> {source.label}</small>}<small>En Google Drive, configura el archivo como “Cualquier persona con el enlace”.</small></div>
              <div className="thumbnail-config">
                <div className="form-group"><label>Miniatura personalizada <span>(opcional)</span></label><div className="url-input"><ImageIcon size={18} /><input value={draft.thumbnailUrl} onChange={(event) => setDraft({ ...draft, thumbnailUrl: event.target.value })} placeholder="Se obtiene automáticamente; pega una imagen solo si quieres reemplazarla" /></div><small>YouTube, Drive, Vimeo y Loom generan su imagen automáticamente. Los MP4 muestran su primer fotograma.</small></div>
                <div className="thumbnail-preview"><VideoThumbnail video={{ title: draft.title || 'Vista previa', url: draft.url, thumbnailUrl: draft.thumbnailUrl }} /><span><ImageIcon size={18} /></span><small>VISTA PREVIA</small></div>
              </div>
              <div className="form-row"><div className="form-group"><label>Duración (opcional)</label><input value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: event.target.value })} placeholder="Ej. 05:30" /></div><label className="feature-check"><input type="checkbox" checked={draft.featured} onChange={(event) => setDraft({ ...draft, featured: event.target.checked })} /><span><Sparkles size={16} /></span><div><strong>Video destacado</strong><small>Aparecerá primero en el inicio</small></div></label></div>
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
  const source = getVideoSource(video.url)
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

function AccessManager({ data, setData }) {
  const [codes, setCodes] = useState(data.codes)
  const [visible, setVisible] = useState({})
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const save = (event) => {
    event.preventDefault()
    const normalizedCodes = Object.values(codes).map((code) => code.trim().toUpperCase())
    if (normalizedCodes.some((code) => code.length < 6)) {
      setError('Cada código debe tener al menos 6 caracteres.')
      return
    }
    if (new Set(normalizedCodes).size !== normalizedCodes.length) {
      setError('Cada rol debe tener un código diferente.')
      return
    }
    setError('')
    setData((current) => ({ ...current, codes: Object.fromEntries(Object.entries(codes).map(([role, code]) => [role, code.trim().toUpperCase()])) }))
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2200)
  }

  return (
    <div className="access-layout">
      <form className="panel access-panel" onSubmit={save}>
        <div className="panel-heading"><div><h2>Claves por perfil</h2><p>Usa un código diferente y difícil de adivinar para cada tipo de acceso.</p></div></div>
        <div className="code-cards">
          {Object.keys(ROLE_META).map((role) => (
            <div className={`code-card code-card--${role}`} key={role}>
              <div className="code-card__role"><span>{ROLE_META[role].short}</span><div><strong>{ROLE_META[role].label}</strong><small>{role === 'admin' ? 'Configuración total' : role === 'operator' ? 'Contenido operativo' : 'Contenido de liderazgo'}</small></div></div>
              <label>Código actual</label>
              <div className="code-editor"><input type={visible[role] ? 'text' : 'password'} value={codes[role]} onChange={(event) => { setCodes({ ...codes, [role]: event.target.value }); setError('') }} /><button type="button" onClick={() => setVisible({ ...visible, [role]: !visible[role] })}>{visible[role] ? <EyeOff size={17} /> : <Eye size={17} />}</button><button type="button" onClick={() => navigator.clipboard?.writeText(codes[role])}><Copy size={17} /></button></div>
              <small className="code-rule">Mínimo 6 caracteres · Se convertirá a mayúsculas</small>
            </div>
          ))}
        </div>
        {error && <p className="form-error form-error--box access-error">{error}</p>}
        <div className="form-actions"><span className={`saved-message ${saved ? 'show' : ''}`}><Check size={15} /> Códigos guardados</span><button className="primary-button" type="submit"><ShieldCheck size={17} /> Guardar códigos</button></div>
      </form>
      <aside className="security-card"><span><LockKeyhole size={22} /></span><h3>Seguridad para producción</h3><p>En esta demo los códigos se guardan en este navegador. Antes de publicar, conéctalos a Supabase mediante una función segura para que nunca queden expuestos en el frontend.</p><ul><li><Check size={14} /> Códigos cifrados</li><li><Check size={14} /> Sesiones con vencimiento</li><li><Check size={14} /> Políticas por rol</li></ul></aside>
    </div>
  )
}

function RolePreview({ data }) {
  const [role, setRole] = useState('operator')
  const [activeSection, setActiveSection] = useState('home')
  const [selectedVideo, setSelectedVideo] = useState(null)
  const [query, setQuery] = useState('')
  const [navOpen, setNavOpen] = useState(false)
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
            <div className="sidebar-help"><span><CircleHelp size={16} /></span><div><strong>¿Necesitas ayuda?</strong><small>Contacta a tu administrador</small></div></div>
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
                <ViewerHome role={role} videos={videos} sections={sections} featured={featured} lockedCount={blockedVideos.length} onPlay={openVideo} onSection={navigate} />
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
        <div className="sidebar-help"><span><CircleHelp size={17} /></span><div><strong>¿Necesitas ayuda?</strong><small>Contacta a tu administrador</small></div></div>
        <div className="sidebar__bottom"><ThemeToggle theme={theme} onToggle={toggleTheme} /><button className="sidebar-action" onClick={onLogout}><LogOut size={18} /><span>Cerrar sesión</span></button></div>
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
            <ViewerHome role={role} videos={targetedVideos} sections={sections} featured={featured} lockedCount={lockedCount} onPlay={openVideo} onSection={navigate} />
          ) : (
            <VideoListing role={role} title={activeSection === 'home' ? 'Resultados de búsqueda' : activeSectionData?.name || 'Videos'} subtitle={query ? `Resultados para “${query}”` : 'Contenido seleccionado para tu perfil'} videos={filtered} onPlay={openVideo} />
          )}
        </main>
      </section>
    </div>
  )
}

function ViewerHome({ role, videos, sections, featured, lockedCount, onPlay, onSection }) {
  const recent = [...videos].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const availableCount = videos.length - lockedCount
  return (
    <div className="viewer-home">
      <div className="viewer-welcome"><div><span className="eyebrow"><Sparkles size={14} /> TU ESPACIO DE APRENDIZAJE</span><h1>Hola, <em>{ROLE_META[role].label}</em></h1><p>Continúa aprendiendo con el contenido preparado para ti.</p></div><div className="viewer-date"><Clock3 size={17} /><span>Contenido actualizado</span></div></div>
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
  const source = locked ? null : getVideoSource(video.url)
  const audience = getVideoAudience(video)
  const audienceMeta = AUDIENCE_META[audience]
  const handlePlay = (event) => {
    event.stopPropagation()
    if (!locked) onPlay()
  }
  return (
    <article className={`viewer-video-card ${locked ? 'viewer-video-card--locked' : ''}`} onClick={locked ? undefined : onPlay} aria-disabled={locked}>
      <div className="viewer-video-card__visual">{!locked && <VideoThumbnail video={video} />}{source && <span className="source-badge"><i style={{ background: getSourceAccent(source.label) }} />{source.label}</span>}<span className={`audience-badge audience-badge--${audience}`}><UsersRound size={11} /> {audienceMeta.label}</span>{locked ? <div className="viewer-video-card__lock"><span><LockKeyhole size={19} /></span><strong>Video bloqueado</strong></div> : <button type="button" onClick={handlePlay} aria-label={`Reproducir ${video.title}`}><Play size={19} fill="currentColor" /></button>}<small>{video.duration}</small></div>
      <div className="viewer-video-card__body">{section && <span>{section.name}</span>}<h3>{video.title}</h3><p>{locked ? 'El administrador mantiene este contenido bloqueado para tu rol.' : video.description}</p><button type="button" disabled={locked} onClick={handlePlay}>{locked ? <><LockKeyhole size={13} /> Contenido bloqueado</> : <>Ver video <ArrowRight size={14} /></>}</button></div>
    </article>
  )
}

function VideoPlayerPage({ video, role, data, onBack, onPlay }) {
  if (!isVideoAssignedTo(video, role) || isVideoLockedFor(video, role)) {
    return <div className="player-page"><button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Volver a la biblioteca</button><div className="player-blocked-state"><span><LockKeyhole size={28} /></span><h2>Este video está bloqueado</h2><p>El administrador no ha habilitado su reproducción para tu rol.</p></div></div>
  }
  const source = getVideoSource(video.url)
  const section = data.sections.find((item) => item.id === video.assignments[role])
  const related = data.videos.filter((item) => item.id !== video.id && item.assignments[role] === video.assignments[role] && !isVideoLockedFor(item, role)).slice(0, 3)
  return (
    <div className="player-page">
      <button className="back-button" onClick={onBack}><ArrowLeft size={17} /> Volver a la biblioteca</button>
      <div className="player-layout">
        <div>
          <div className="video-frame">
            {source.type === 'video' ? <video src={source.embedUrl} controls playsInline /> : source.type === 'iframe' ? <iframe src={source.embedUrl} title={video.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen /> : <div className="video-error"><Film size={32} /><p>No se pudo cargar este enlace.</p></div>}
          </div>
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
