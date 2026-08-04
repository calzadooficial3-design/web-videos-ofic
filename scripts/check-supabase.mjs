import { loadEnv } from 'vite'
import { createClient } from '@supabase/supabase-js'

const env = loadEnv('development', process.cwd(), '')
const projectUrl = env.VITE_SUPABASE_URL?.replace(/\/$/, '')
const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY
const secretKey = env.SUPABASE_SECRET_KEY

if (!projectUrl || !publishableKey || !secretKey) {
  console.error('Faltan variables requeridas en .env')
  process.exit(1)
}

const checks = [
  { name: 'Auth con clave publicable', path: '/auth/v1/settings', key: publishableKey },
  { name: 'REST administrativo con clave secreta', path: '/rest/v1/', key: secretKey },
]

let failed = false

for (const check of checks) {
  try {
    const response = await fetch(`${projectUrl}${check.path}`, {
      headers: { apikey: check.key },
      signal: AbortSignal.timeout(15_000),
    })
    const ok = response.status >= 200 && response.status < 300
    console.log(`${ok ? 'OK' : 'ERROR'} · ${check.name} · HTTP ${response.status}`)
    if (!ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
      console.log(`  ${detail || 'Sin detalle adicional'}`)
      failed = true
    }
  } catch (error) {
    console.log(`ERROR · ${check.name} · ${error.name}`)
    failed = true
  }
}

try {
  const supabase = createClient(projectUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error, status } = await supabase.from('sections').select('id').limit(1)

  if (!error) {
    console.log(`OK · Cliente web y API de datos · HTTP ${status}`)
  } else if (error.code === 'PGRST205') {
    console.log('OK · Cliente web conectado; la tabla public.sections todavía no existe en el proyecto')
  } else {
    console.log(`ERROR · Cliente web y API de datos · HTTP ${status || 'sin respuesta'} · ${error.code || error.message}`)
    failed = true
  }
} catch (error) {
  console.log(`ERROR · Cliente web y API de datos · ${error.name}`)
  failed = true
}

if (failed) process.exit(1)
