import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdminSaveRevisionTracker } from '../src/lib/adminSaveRevision.js'

test('rebasa un snapshot capturado mientras otro guardado estaba en curso', () => {
  const tracker = createAdminSaveRevisionTracker(7)
  const firstSnapshot = { revision: 7, videos: [{ id: 'first' }] }
  const queuedSnapshot = { revision: 7, videos: [{ id: 'first' }, { id: 'second' }] }

  assert.equal(tracker.rebase(firstSnapshot).revision, 7)

  // Supabase confirma el primer guardado antes de ejecutar el que estaba en cola.
  tracker.confirm(8)
  const rebasedSnapshot = tracker.rebase(queuedSnapshot)

  assert.equal(rebasedSnapshot.revision, 8)
  assert.equal(queuedSnapshot.revision, 7)
  assert.deepEqual(rebasedSnapshot.videos, queuedSnapshot.videos)
})

test('una confirmación tardía no puede hacer retroceder la revisión', () => {
  const tracker = createAdminSaveRevisionTracker(10)

  tracker.confirm(11)
  tracker.confirm(9)

  assert.equal(tracker.current(), 11)
})
