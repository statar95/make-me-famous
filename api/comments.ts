import { z } from 'zod'
import { refreshAnalytics } from './_analytics.js'
import { LOG_KEEP } from './_engagement.js'
import { json, mutate, readState, requireAuth } from './_lib.js'
import { applyMentions, config, unipile } from './_publish.js'

// The comment cockpit: comments on your last week of posts that you haven't replied to, and replying.

const WINDOW_MS = 7 * 86_400_000

interface RawComment {
  id?: string
  text?: string
  date?: string
  author?: string | null
  reply_counter?: number
  reaction_counter?: number
  author_details?: {
    id?: string | null
    headline?: string | null
    profile_url?: string | null
    profile_picture_url?: string | null
    network_distance?: string | null
  }
}

export interface CockpitComment {
  id: string
  text: string
  date: string
  author: string
  authorId: string
  headline?: string
  picture?: string
  profileUrl?: string
  degree?: string
  reactions: number
  replyCount: number
  /** Replies already under it (from other people), oldest first, for context. */
  replies: { author: string; text: string }[]
}

export interface CockpitPost {
  socialId: string
  url?: string
  date: string
  preview: string
  comments: CockpitComment[]
}

const toComment = (c: RawComment): CockpitComment | null => {
  if (!c.id || typeof c.text !== 'string' || !c.author_details?.id) return null
  return {
    id: c.id,
    text: c.text,
    date: c.date ?? '',
    author: c.author ?? 'Someone',
    authorId: c.author_details.id,
    headline: c.author_details.headline ?? undefined,
    picture: c.author_details.profile_picture_url ?? undefined,
    profileUrl: c.author_details.profile_url ?? undefined,
    degree: { DISTANCE_1: '1st', DISTANCE_2: '2nd', DISTANCE_3: '3rd', FIRST_DEGREE: '1st', SECOND_DEGREE: '2nd', THIRD_DEGREE: '3rd' }[
      c.author_details.network_distance ?? ''
    ],
    reactions: c.reaction_counter ?? 0,
    replyCount: c.reply_counter ?? 0,
    replies: [],
  }
}

type Cfg = NonNullable<ReturnType<typeof config>>

/** Runs fn over items a few at a time, so a busy week doesn't trip Unipile's rate limit. */
async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}
const list = (c: Cfg, socialId: string, commentId?: string) =>
  unipile<{ items?: RawComment[] }>(
    c,
    `/api/v1/posts/${encodeURIComponent(socialId)}/comments?account_id=${encodeURIComponent(c.account)}&limit=100${
      commentId ? `&comment_id=${encodeURIComponent(commentId)}` : ''
    }`,
  ).then((r) => r.items ?? [])

/** GET /api/comments -> posts from the last 7 days with the comments you haven't answered. */
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const c = config()
  if (!c) return json({ error: 'Unipile is not configured' }, 503)

  const analytics = await refreshAnalytics()
  const me = analytics.providerId
  if (!me) return json({ error: 'Could not work out your LinkedIn id yet. Open Results once, then try again.' }, 503)

  const since = Date.now() - WINDOW_MS
  const recent = new Map<string, CockpitPost>()
  for (const p of analytics.posts)
    if (p.socialId && Date.parse(p.date) >= since)
      recent.set(p.socialId, { socialId: p.socialId, url: p.url, date: p.date, preview: p.preview, comments: [] })
  // Posts the app sent in the last few hours may not be in the 6-hourly snapshot yet.
  for (const p of (await readState()).posts) {
    const r = p.results?.[0]
    if (p.status === 'posted' && r?.socialId && p.postedAt && Date.parse(p.postedAt) >= since && !recent.has(r.socialId))
      recent.set(r.socialId, {
        socialId: r.socialId,
        date: p.postedAt,
        preview: p.text.replace(/\s+/g, ' ').trim().slice(0, 140),
        comments: [],
      })
  }

  const repliedHere = (await readState()).replied ?? {}
  const posts = await inBatches([...recent.values()], 2, async (post) => {
    try {
      const top = (await list(c, post.socialId)).map(toComment).filter((x): x is CockpitComment => !!x)
      const theirs = top.filter((x) => x.authorId !== me && !repliedHere[x.id])
      let unchecked = 0
      const withReplies = await inBatches(theirs, 3, async (x) => {
        if (!x.replyCount) return x
        try {
          const replies = (await list(c, post.socialId, x.id)).map(toComment).filter((r): r is CockpitComment => !!r)
          if (replies.some((r) => r.authorId === me)) return null
          return { ...x, replies: replies.map((r) => ({ author: r.author, text: r.text })) }
        } catch {
          // Can't tell whether you've already answered: leave it out rather than invite a second reply.
          unchecked++
          return null
        }
      })
      return {
        ...post,
        comments: withReplies.filter((x): x is CockpitComment => !!x),
        error: unchecked ? `${unchecked} comment${unchecked > 1 ? 's' : ''} couldn't be checked. Refresh in a minute.` : undefined,
      }
    } catch (e) {
      console.error('[comments] list failed', e instanceof Error ? e.message : e)
      return { ...post, comments: [], error: 'Could not load comments for this post' }
    }
  })
  posts.sort((a, b) => b.date.localeCompare(a.date))
  return json({ posts, fetchedAt: new Date().toISOString() })
}

const Reply = z.object({
  socialId: z.string().min(1).max(200),
  /** Omit to comment on the post itself rather than reply to a comment. */
  commentId: z.string().min(1).max(100).optional(),
  text: z.string().trim().min(1).max(1250),
  mentions: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        profileId: z.string().regex(/^(AC|AD)[A-Za-z0-9_-]+$|^\d+$/),
        isCompany: z.boolean().optional(),
      }),
    )
    .max(5)
    .optional(),
  /** Comments tab only: who and why, so the outcome can be tracked. */
  meta: z
    .object({
      author: z.string().min(1).max(200),
      authorId: z.string().max(200).optional(),
      url: z.string().url().startsWith('https://').max(500).optional(),
      source: z.enum(['watchlist', 'topic', 'feed', 'sector']),
      topic: z.string().max(80).optional(),
    })
    .optional()
    // Odd metadata only loses the log entry; it never blocks the comment.
    .catch(undefined),
})

/** POST /api/comments {socialId, commentId, text, mentions?} -> replies on LinkedIn under that comment. */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const c = config()
  if (!c) return json({ error: 'Unipile is not configured' }, 503)
  const parsed = Reply.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'Bad reply' }, 400)
  const { socialId, commentId, text, mentions, meta } = parsed.data

  // One reply per comment: claim it first, so a double click or a second tab can't send twice.
  // Commenting on someone's post: refuse if you've already commented there (in the app or not).
  if (!commentId) {
    const me = (await readState()).analytics?.providerId
    if (!me) return json({ error: 'Could not work out your LinkedIn id yet. Open Results once, then try again.' }, 503)
    try {
      if ((await list(c, socialId)).some((x) => x.author_details?.id === me))
        return json({ error: "You've already commented on this post" }, 409)
    } catch {
      return json({ error: "Couldn't check whether you've already commented. Try again in a minute." }, 502)
    }
  }

  const key = commentId ?? `post:${socialId}`
  let already = false
  await mutate((s) => {
    already = !!s.replied?.[key]
    if (!already) s.replied = { ...(s.replied ?? {}), [key]: new Date().toISOString() }
  })
  if (already) return json({ error: commentId ? 'You already replied to that comment' : 'You already commented on that post' }, 409)

  const form = new FormData()
  form.append('account_id', c.account)
  if (commentId) form.append('comment_id', commentId)
  form.append('text', applyMentions(text, mentions, form).text)
  try {
    const res = await unipile<{ comment_id?: string }>(c, `/api/v1/posts/${encodeURIComponent(socialId)}/comments`, {
      method: 'POST',
      body: form,
    })
    console.log('[comments] replied', { chars: text.length })
    if (!commentId && meta) {
      // The comment is out; a failed log must not turn that into an error and invite a resend.
      try {
        await mutate((s) => {
          const log = (s.commentLog ?? []).filter((l) => l.socialId !== socialId)
          log.push({ socialId, commentId: res?.comment_id, ...meta, at: new Date().toISOString() })
          s.commentLog = log.slice(-LOG_KEEP)
        })
      } catch (e) {
        console.error('[comments] could not log comment', e instanceof Error ? e.message : e)
      }
    }
    return json({ ok: true, id: res?.comment_id })
  } catch (e) {
    // Only a clear refusal frees the claim; a timeout may still have posted, so keep it claimed.
    const status = e instanceof Error ? Number(/Unipile (\d{3})/.exec(e.message)?.[1]) : NaN
    if (status >= 400 && status < 500)
      await mutate((s) => {
        if (s.replied) delete s.replied[key]
      })
    return json({ error: e instanceof Error ? e.message : 'Reply failed' }, 502)
  }
}
