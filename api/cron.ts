import { json, mutate, readState, safeEqual } from './_lib.js'
import { refreshAnalytics } from './_analytics.js'
import { publishPost } from './_publish.js'

const STUCK_MS = 10 * 60_000

/** GET /api/cron  Called by Vercel Cron. Publishes at most one due post per run. */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return json({ error: 'CRON_SECRET is not configured' }, 503)
  if (!safeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) return json({ error: 'Not authorized' }, 401)

  const now = Date.now()
  const state = await readState()
  const stuckPost = (p: (typeof state.posts)[number]) =>
    p.status === 'publishing' && now - Date.parse(p.updatedAt) > STUCK_MS
  const stuckComment = (p: (typeof state.posts)[number]) =>
    p.comment?.status === 'sending' && now - Date.parse(p.comment.at) > STUCK_MS
  if (state.posts.some((p) => stuckPost(p) || stuckComment(p))) {
    await mutate((s) => {
      for (const p of s.posts) {
        if (stuckPost(p)) {
          p.status = 'failed'
          p.error = 'Publishing never confirmed. Check LinkedIn before trying again, in case it went out.'
          p.updatedAt = new Date().toISOString()
        }
        if (stuckComment(p))
          p.comment = {
            status: 'failed',
            error: 'Comment never confirmed. Check LinkedIn before retrying, in case it went out.',
            at: new Date().toISOString(),
          }
      }
    })
  }

  const due = state.posts
    .filter((p) => p.status === 'scheduled' && p.scheduledAt && Date.parse(p.scheduledAt) <= now)
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0]

  let body: Record<string, unknown> = { published: null }
  if (due) {
    const result = await publishPost(due.id)
    body = result.ok ? { published: due.id } : { published: null, id: due.id, error: result.error }
  }

  // Publishing goes first. Analytics only piggybacks, and only when it's 6 hours stale.
  try {
    const a = await refreshAnalytics()
    body.analyticsAt = a.fetchedAt ?? null
  } catch (e) {
    console.error('[cron] analytics', e instanceof Error ? e.message : e)
  }
  return json(body)
}
