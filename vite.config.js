import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import loginWithCode from './netlify/functions/login-with-code.js'
import rotateAccessCodes from './netlify/functions/rotate-access-codes.js'
import saveAdminSnapshot from './netlify/functions/save-admin-snapshot.js'

const LOCAL_FUNCTIONS = new Map([
  ['/login-with-code', loginWithCode],
  ['/rotate-access-codes', rotateAccessCodes],
  ['/save-admin-snapshot', saveAdminSnapshot],
])

async function toWebRequest(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const headers = new Headers()
  Object.entries(request.headers).forEach(([name, value]) => {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item))
    else if (value !== undefined) headers.set(name, value)
  })

  const method = request.method || 'GET'
  const origin = `http://${request.headers.host || '127.0.0.1'}`
  return new Request(new URL(request.originalUrl || request.url || '/', origin), {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks),
  })
}

function localFunctionsPlugin(environment) {
  process.env.SUPABASE_URL ||= environment.SUPABASE_URL || environment.VITE_SUPABASE_URL
  process.env.SUPABASE_PUBLISHABLE_KEY ||= environment.SUPABASE_PUBLISHABLE_KEY || environment.VITE_SUPABASE_PUBLISHABLE_KEY
  process.env.SUPABASE_SECRET_KEY ||= environment.SUPABASE_SECRET_KEY
  if (environment.ACCESS_CODE_PEPPER) {
    process.env.ACCESS_CODE_PEPPER ||= environment.ACCESS_CODE_PEPPER
  }

  return {
    name: 'local-netlify-functions',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/.netlify/functions', async (request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://local').pathname
        const handler = LOCAL_FUNCTIONS.get(pathname)
        if (!handler) {
          next()
          return
        }

        try {
          const functionResponse = await handler(await toWebRequest(request), {
            ip: request.socket.remoteAddress || 'local',
          })
          response.statusCode = functionResponse.status
          functionResponse.headers.forEach((value, name) => response.setHeader(name, value))
          response.end(Buffer.from(await functionResponse.arrayBuffer()))
        } catch {
          response.statusCode = 500
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify({ error: 'La función local no está disponible.' }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), localFunctionsPlugin(loadEnv(mode, process.cwd(), ''))],
  server: {
    host: '127.0.0.1',
  },
}))
