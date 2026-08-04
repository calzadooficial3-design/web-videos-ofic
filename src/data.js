export const ROLE_META = {
  admin: { label: 'Administrador', short: 'AD' },
  operator: { label: 'Operante', short: 'OP' },
  boss: { label: 'Jefe', short: 'JF' },
}

export const DEFAULT_CODES = {
  admin: 'AUREA26',
  operator: 'OPERA26',
  boss: 'JEFE26',
}

export const DEFAULT_SECTIONS = [
  { id: 'operations', name: 'Operaciones', icon: 'layers', roles: ['operator'], order: 0 },
  { id: 'security', name: 'Seguridad', icon: 'shield', roles: ['operator', 'boss'], order: 1 },
  { id: 'leadership', name: 'Liderazgo', icon: 'briefcase', roles: ['boss'], order: 2 },
  { id: 'updates', name: 'Actualizaciones', icon: 'sparkles', roles: ['operator', 'boss'], order: 3 },
]

export const DEFAULT_VIDEOS = [
  {
    id: 'welcome-video',
    title: 'Bienvenida al equipo',
    description: 'Una introducción breve a la cultura, los valores y la manera en que trabajamos juntos.',
    url: 'https://www.youtube.com/watch?v=ysz5S6PUM-U',
    duration: '2:12',
    assignments: { operator: 'operations', boss: 'leadership' },
    locked: {},
    featured: true,
    createdAt: '2026-08-01T10:00:00.000Z',
  },
  {
    id: 'safe-work',
    title: 'Protocolo de trabajo seguro',
    description: 'Pasos esenciales que debes completar antes de iniciar una operación en campo.',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    duration: '4:18',
    assignments: { operator: 'security' },
    locked: {},
    featured: false,
    createdAt: '2026-07-28T10:00:00.000Z',
  },
  {
    id: 'leadership-focus',
    title: 'Liderazgo con propósito',
    description: 'Herramientas prácticas para comunicar prioridades, acompañar al equipo y tomar decisiones.',
    url: 'https://vimeo.com/863362136',
    duration: '8:40',
    assignments: { boss: 'leadership' },
    locked: {},
    featured: true,
    createdAt: '2026-07-25T10:00:00.000Z',
  },
  {
    id: 'weekly-update',
    title: 'Novedades de la semana',
    description: 'Resumen de cambios, recordatorios y próximos hitos importantes para toda la organización.',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    duration: '3:05',
    assignments: { operator: 'updates', boss: 'updates' },
    locked: {},
    featured: false,
    createdAt: '2026-08-03T10:00:00.000Z',
  },
]

export const createDefaultData = () => ({
  sections: DEFAULT_SECTIONS,
  videos: DEFAULT_VIDEOS,
  codes: DEFAULT_CODES,
  organization: 'Almacén de Remates',
})
