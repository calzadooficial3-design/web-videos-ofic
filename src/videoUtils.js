export function getVideoSource(rawUrl = '') {
  const value = rawUrl.trim()
  if (!value) return { type: 'empty', embedUrl: '', label: 'Sin enlace' }

  try {
    const url = new URL(value)
    const host = url.hostname.replace('www.', '')

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0]
      return { type: 'iframe', embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, label: 'YouTube' }
    }

    if (host.includes('youtube.com')) {
      const parts = url.pathname.split('/').filter(Boolean)
      const id = url.searchParams.get('v') || (['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : '')
      if (id) return { type: 'iframe', embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, label: 'YouTube' }
    }

    if (host.includes('drive.google.com')) {
      const match = url.pathname.match(/\/file\/d\/([^/]+)/) || url.pathname.match(/\/d\/([^/]+)/)
      const id = match?.[1] || url.searchParams.get('id')
      if (id) return { type: 'iframe', embedUrl: `https://drive.google.com/file/d/${id}/preview`, label: 'Google Drive' }
    }

    if (host.includes('vimeo.com')) {
      const id = url.pathname.split('/').filter(Boolean).find((part) => /^\d+$/.test(part))
      if (id) return { type: 'iframe', embedUrl: `https://player.vimeo.com/video/${id}`, label: 'Vimeo' }
    }

    if (host.includes('loom.com')) {
      const parts = url.pathname.split('/').filter(Boolean)
      const id = parts.at(-1)
      if (id) return { type: 'iframe', embedUrl: `https://www.loom.com/embed/${id}`, label: 'Loom' }
    }

    if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(value)) {
      return { type: 'video', embedUrl: value, label: 'Archivo directo' }
    }

    return { type: 'iframe', embedUrl: value, label: 'Sitio externo' }
  } catch {
    return { type: 'invalid', embedUrl: '', label: 'Enlace no válido' }
  }
}

export function getSourceAccent(label) {
  return {
    YouTube: '#f04444',
    'Google Drive': '#3c8cf5',
    Vimeo: '#36b9f4',
    Loom: '#8b5cf6',
    'Archivo directo': '#cda85e',
  }[label] || '#9a927f'
}
