import { z } from 'zod'
import { json, requireAuth } from './_lib.js'
import { config, unipile } from './_publish.js'

const Body = z.object({
  socialId: z.string().min(1).max(200),
  /** Set to react to a comment under the post instead of the post. */
  commentId: z.string().min(1).max(100).optional(),
  reaction: z.enum(['like', 'celebrate', 'support', 'love', 'insightful', 'funny']).default('like'),
})

/** POST /api/react {socialId, commentId?, reaction?} -> likes (or reacts to) a post or comment on LinkedIn. */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const c = config()
  if (!c) return json({ error: 'Unipile is not configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'Bad reaction' }, 400)
  const { socialId, commentId, reaction } = parsed.data
  try {
    await unipile(c, '/api/v1/posts/reaction', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: c.account, post_id: socialId, comment_id: commentId, reaction_type: reaction }),
    })
    return json({ ok: true })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Reaction failed' }, 502)
  }
}
