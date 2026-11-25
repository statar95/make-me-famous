import { json, requireAuth } from './_lib.js'
import { retryComment } from './_publish.js'

/** POST /api/comment  body: { id }  -> re-send only the first comment of a posted post */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const { id } = (await req.json().catch(() => ({}))) as { id?: string }
  if (!id) return json({ error: 'Missing id' }, 400)
  const result = await retryComment(id)
  return result.ok ? json({ ok: true, post: result.post }) : json({ error: result.error }, result.status)
}
