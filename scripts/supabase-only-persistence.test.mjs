import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  getServerConfiguration,
  ServerConfigurationError,
} from '../netlify/functions/_shared/supabase-server.js'

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

test('Netlify informa exactamente las variables de servidor ausentes', () => {
  const keys = [
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'ACCESS_CODE_PEPPER',
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

  try {
    keys.forEach((key) => { delete process.env[key] })
    assert.throws(
      () => getServerConfiguration(),
      (error) => (
        error instanceof ServerConfigurationError
        && error.code === 'SERVER_CONFIGURATION_MISSING'
        && error.missingVariables.includes('SUPABASE_SECRET_KEY')
      ),
    )
  } finally {
    keys.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    })
  }
})
