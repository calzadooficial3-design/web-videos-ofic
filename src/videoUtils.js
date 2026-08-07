export const VIDEO_THUMBNAIL_SECOND = 4

export function parseDurationSeconds(label) {
  const pieces = String(label || '').trim().split(':').map(Number)
  if (!pieces.length || pieces.some((piece) => !Number.isInteger(piece) || piece < 0)) return null
  if (pieces.length === 2 && pieces[1] < 60) return pieces[0] * 60 + pieces[1]
  if (pieces.length === 3 && pieces[1] < 60 && pieces[2] < 60) {
    return pieces[0] * 3600 + pieces[1] * 60 + pieces[2]
  }
  return null
}

export function getThumbnailSeekTime(duration, targetSecond = VIDEO_THUMBNAIL_SECOND) {
  const safeTarget = Number.isFinite(targetSecond) && targetSecond >= 0
    ? targetSecond
    : VIDEO_THUMBNAIL_SECOND

  if (!Number.isFinite(duration) || duration <= 0) return safeTarget

  return Math.min(safeTarget, Math.max(0, duration - 0.05))
}

export function getVideoThumbnailUrl(rawUrl = '', targetSecond = VIDEO_THUMBNAIL_SECOND) {
  const value = rawUrl.trim()
  if (!value) return ''

  const safeTarget = Number.isFinite(targetSecond) && targetSecond >= 0
    ? targetSecond
    : VIDEO_THUMBNAIL_SECOND

  try {
    const url = new URL(value)
    url.hash = `t=${safeTarget}`
    return url.toString()
  } catch {
    return value
  }
}

export function getVideoSource(rawUrl = '') {
  const value = rawUrl.trim()
  if (!value) return { type: 'empty', embedUrl: '', label: 'Sin enlace' }

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') {
      return { type: 'invalid', embedUrl: '', label: 'Enlace no permitido' }
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, '')

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0]
      if (!id || !/^[\w-]{6,}$/.test(id)) {
        return { type: 'invalid', embedUrl: '', label: 'Enlace de YouTube no válido' }
      }
      return {
        type: 'iframe',
        provider: 'youtube',
        id,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        label: 'YouTube',
      }
    }

    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const parts = url.pathname.split('/').filter(Boolean)
      const id = url.searchParams.get('v') || (['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : '')
      if (id && /^[\w-]{6,}$/.test(id)) return {
        type: 'iframe',
        provider: 'youtube',
        id,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        label: 'YouTube',
      }
    }

    if (host === 'drive.google.com') {
      const match = url.pathname.match(/\/file\/d\/([^/]+)/) || url.pathname.match(/\/d\/([^/]+)/)
      const id = match?.[1] || url.searchParams.get('id')
      if (id) return {
        type: 'iframe',
        provider: 'google_drive',
        id,
        embedUrl: `https://drive.google.com/file/d/${id}/preview`,
        thumbnailUrl: `https://drive.google.com/thumbnail?id=${id}&sz=w1280`,
        label: 'Google Drive',
      }
    }

    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = url.pathname.split('/').filter(Boolean).find((part) => /^\d+$/.test(part))
      if (id) return {
        type: 'iframe',
        provider: 'vimeo',
        id,
        embedUrl: `https://player.vimeo.com/video/${id}`,
        label: 'Vimeo',
      }
    }

    if (host === 'loom.com' || host.endsWith('.loom.com')) {
      const parts = url.pathname.split('/').filter(Boolean)
      const id = parts.at(-1)
      if (id) return {
        type: 'iframe',
        provider: 'loom',
        id,
        embedUrl: `https://www.loom.com/embed/${id}`,
        thumbnailUrl: `https://cdn.loom.com/sessions/thumbnails/${id}-with-play.gif`,
        label: 'Loom',
      }
    }

    if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(value)) {
      return { type: 'video', provider: 'direct', embedUrl: value, label: 'Archivo directo' }
    }

    return { type: 'invalid', embedUrl: '', label: 'Proveedor no compatible' }
  } catch {
    return { type: 'invalid', embedUrl: '', label: 'Enlace no válido' }
  }
}

const remoteThumbnailCache = new Map()

export async function resolveVideoThumbnail(rawUrl = '') {
  const source = getVideoSource(rawUrl)
  if (source.thumbnailUrl) return source.thumbnailUrl

  if (source.provider === 'vimeo') {
    if (remoteThumbnailCache.has(rawUrl)) return remoteThumbnailCache.get(rawUrl)

    const request = (async () => {
      try {
        const endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(rawUrl)}`
        const response = await fetch(endpoint)
        if (!response.ok) return ''
        const data = await response.json()
        return data.thumbnail_url || ''
      } catch {
        return ''
      }
    })()

    remoteThumbnailCache.set(rawUrl, request)
    return request
  }

  return ''
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
