import react from '@vitejs/plugin-react'
import { type Plugin, defineConfig, loadEnv } from 'vite'

/** Serves api/*.ts in `npm run dev` the way Vercel Functions do in production. */
function localApi(): Plugin {
  return {
    name: 'local-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv(server.config.mode, process.cwd(), ''))
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.match(/^\/api\/([a-z-]+)$/)?.[1]
        if (!route) return next()
        try {
          const mod = await server.ssrLoadModule(`/api/${route}.ts`)
          const handler = mod[req.method ?? 'GET']
          if (!handler) return void ((res.statusCode = 405), res.end())
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          const body = chunks.length ? Buffer.concat(chunks) : undefined
          const request = new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          })
          const response: Response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((v, k) => res.setHeader(k, v.replace('; Secure', '')))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          next(e)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localApi()],
})
