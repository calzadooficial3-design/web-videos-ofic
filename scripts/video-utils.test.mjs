import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getThumbnailSeekTime,
  getVideoThumbnailUrl,
  VIDEO_THUMBNAIL_SECOND,
} from '../src/videoUtils.js'

test('la miniatura de un archivo directo apunta al segundo 3', () => {
  assert.equal(VIDEO_THUMBNAIL_SECOND, 3)
  assert.equal(
    getVideoThumbnailUrl('https://cdn.example.com/video.mp4?token=abc'),
    'https://cdn.example.com/video.mp4?token=abc#t=3',
  )
})

test('el fragmento anterior se reemplaza por el segundo configurado', () => {
  assert.equal(
    getVideoThumbnailUrl('https://cdn.example.com/video.webm#t=0.1'),
    'https://cdn.example.com/video.webm#t=3',
  )
})

test('los videos cortos usan el último instante reproducible', () => {
  assert.equal(getThumbnailSeekTime(10), 3)
  assert.equal(getThumbnailSeekTime(3), 2.95)
  assert.equal(getThumbnailSeekTime(2), 1.95)
  assert.equal(getThumbnailSeekTime(0.04), 0)
  assert.equal(getThumbnailSeekTime(Number.NaN), 3)
})
