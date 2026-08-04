import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [appSource, apiSource, saveFunctionSource] = await Promise.all([
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/videoHubApi.js', import.meta.url), 'utf8'),
  readFile(new URL('../netlify/functions/save-admin-snapshot.js', import.meta.url), 'utf8'),
])

test('el contenido no usa almacenamiento local del navegador', () => {
  assert.doesNotMatch(appSource, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/)
})

test('el guardado administrativo exige Netlify y la RPC atómica', () => {
  assert.match(apiSource, /SAVE_SNAPSHOT_FUNCTION_URL/)
  assert.match(saveFunctionSource, /rpc\('save_admin_snapshot'/)
  assert.doesNotMatch(apiSource, /atomicSave\.unsupported|upsertRows\(|archiveRowsByIds\(/)
  assert.doesNotMatch(saveFunctionSource, /unsupported\s*:/)
})
