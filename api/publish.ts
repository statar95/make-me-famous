import { json, requireAuth } from './_lib.js'
import { publishPost } from './_publish.js'

/** POST /api/publish  body: { id }  -> publish now, for real */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const { id } = (await req.json().catch(() => ({}))) as { id?: string }
  if (!id) return json({ error: 'Missing id' }, 400)
  const result = await publishPost(id)
  return result.ok ? json({ ok: true, post: result.post }) : json({ error: result.error }, result.status)
}
