import { json, mutate, requireAuth } from './_lib.js'
import { nextFreeSlot } from './_slots.js'

/** POST /api/queue  body: { id }  -> schedules a draft into the next free slot */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const { id } = (await req.json().catch(() => ({}))) as { id?: string }
  if (!id) return json({ error: 'Missing id' }, 400)

  let refusal: { status: number; error: string } | null = null
  let scheduledAt: string | null = null
  await mutate((s) => {
    refusal = null
    scheduledAt = null
    const post = s.posts.find((p) => p.id === id)
    if (!post) return void (refusal = { status: 404, error: 'Post not found' })
    if (post.status !== 'draft') return void (refusal = { status: 409, error: 'Only drafts can be queued' })
    if (!post.text.trim()) return void (refusal = { status: 400, error: 'Write something first' })
    const at = nextFreeSlot(s.schedule, s.posts, Date.now(), post.id)
    if (at === null) return void (refusal = { status: 409, error: 'No free slots. Add some in Plan.' })
    scheduledAt = new Date(at).toISOString()
    post.status = 'scheduled'
    post.scheduledAt = scheduledAt
    post.platforms = ['linkedin']
    post.updatedAt = new Date().toISOString()
  })
  if (refusal) return json({ error: (refusal as { error: string }).error }, (refusal as { status: number }).status)
  return json({ ok: true, scheduledAt })
}
