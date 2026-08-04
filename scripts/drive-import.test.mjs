import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getDriveDownloadUrl,
  getStorageObjectPath,
  getVideoExtension,
  normalizeVideoIds,
} from '../netlify/functions/import-drive-videos.js'

test('normaliza, deduplica y descarta identificadores de video inválidos', () => {
  assert.deepEqual(normalizeVideoIds([
    '550E8400-E29B-41D4-A716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
    'no-es-uuid',
  ]), ['550e8400-e29b-41d4-a716-446655440000'])
})

test('construye la descarga de Drive solo con un ID de archivo seguro', () => {
  const downloadUrl = new URL(getDriveDownloadUrl(
    '1AbCdEfGhIjKlMnOp',
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?resourcekey=0-safe_Key',
  ))
  assert.equal(downloadUrl.origin, 'https://drive.usercontent.google.com')
  assert.equal(downloadUrl.searchParams.get('id'), '1AbCdEfGhIjKlMnOp')
  assert.equal(downloadUrl.searchParams.get('resourcekey'), '0-safe_Key')
  assert.equal(getDriveDownloadUrl('https://evil.example/video.mp4'), '')
})

test('acepta solamente los formatos de video admitidos por Storage', () => {
  assert.equal(getVideoExtension('video/mp4; charset=binary'), 'mp4')
  assert.equal(getVideoExtension('video/webm'), 'webm')
  assert.equal(getVideoExtension('video/ogg'), 'ogg')
  assert.equal(getVideoExtension('text/html'), '')
})

test('la ruta privada pertenece al UUID del video y es estable para la fuente', () => {
  const videoId = '550e8400-e29b-41d4-a716-446655440000'
  const first = getStorageObjectPath(videoId, '1AbCdEfGhIjKlMnOp', 'mp4')
  const second = getStorageObjectPath(videoId, '1AbCdEfGhIjKlMnOp', 'mp4')
  const changed = getStorageObjectPath(videoId, '1DifferentDriveId', 'mp4')

  assert.match(first, /^550e8400-e29b-41d4-a716-446655440000\/drive-[a-f0-9]{16}\.mp4$/)
  assert.equal(first, second)
  assert.notEqual(first, changed)
})
