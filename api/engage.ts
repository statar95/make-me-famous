import { z } from 'zod'
import { type EngageSettings, json, mutate, readState, requireAuth } from './_lib.js'
import { config, unipile } from './_publish.js'

// Posts worth commenting on: recent posts from a watchlist of people, plus topic searches filtered
// to ones with real engagement. Unipile has no home-feed endpoint, so this assembles one.

const WATCH_WINDOW_MS = 3 * 86_400_000

export const defaultEngage = (): EngageSettings => ({ watchlist: [], topics: [], minReactions: 25 })

interface RawPost {
  social_id?: string
  text?: string
  parsed_datetime?: string
  date?: string
  share_url?: string
  reaction_counter?: number
  comment_counter?: number
  is_repost?: boolean
  permissions?: { can_post_comments?: boolean }
  author?: { id?: string; name?: string; headline?: string; profile_picture_url?: string; public_identifier?: string; is_company?: boolean }
}

export interface FeedPost {
  socialId: string
  url?: string
  date: string
  text: string
  reactions: number
  comments: number
  author: string
  authorId?: string
  headline?: string
  picture?: string
  source: 'watchlist' | 'topic'
  topic?: string
}

const toFeed = (p: RawPost, source: FeedPost['source'], topic?: string): FeedPost | null => {
  if (!p.social_id || !p.text || p.is_repost || p.permissions?.can_post_comments === false) return null
  return {
    socialId: p.social_id,
    url: p.share_url,
    date: p.parsed_datetime ?? p.date ?? '',
    text: p.text,
    reactions: p.reaction_counter ?? 0,
    comments: p.comment_counter ?? 0,
    author: p.author?.name ?? 'Someone',
    authorId: p.author?.id,
    headline: p.author?.headline,
    picture: p.author?.profile_picture_url,
    source,
    topic,
  }
}

type Cfg = NonNullable<ReturnType<typeof config>>

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** Gives up on one slow call so the whole tab still loads. */
const within = <T,>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

const watchPosts = (c: Cfg, profileId: string) =>
  unipile<{ items?: RawPost[] }>(
    c,
    `/api/v1/users/${encodeURIComponent(profileId)}/posts?account_id=${encodeURIComponent(c.account)}&limit=5`,
  ).then((r) => r.items ?? [])

const topicPosts = (c: Cfg, topic: string) =>
  unipile<{ items?: RawPost[] }>(c, `/api/v1/linkedin/search?account_id=${encodeURIComponent(c.account)}&limit=50`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: 'classic', category: 'posts', keywords: topic, date_posted: 'past_week', sort_by: 'relevance' }),
  }).then((r) => r.items ?? [])

/** GET /api/engage -> {settings, posts, errors}: posts worth a comment, best first. */
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const c = config()
  if (!c) return json({ error: 'Unipile is not configured' }, 503)
  const s = await readState()
  const settings = s.engage ?? defaultEngage()
  const done = s.replied ?? {}
  const me = s.analytics?.providerId
  const errors: string[] = []

  const since = Date.now() - WATCH_WINDOW_MS
  const watchedP = inBatches(settings.watchlist, 6, async (w) => {
      try {
        return (await within(12_000, watchPosts(c, w.profileId)))
          .map((p) => toFeed(p, 'watchlist'))
          .filter((p): p is FeedPost => !!p && Date.parse(p.date) >= since)
      } catch {
        errors.push(`Couldn't load ${w.name}'s posts`)
        return []
      }
    })
  const foundP = inBatches(settings.topics, 8, async (t) => {
      try {
        return (await within(30_000, topicPosts(c, t)))
          .map((p) => toFeed(p, 'topic', t))
          .filter((p): p is FeedPost => !!p && p.reactions >= settings.minReactions)
      } catch {
        errors.push(`Couldn't search "${t}"`)
        return []
      }
    })
  // Watchlist and topics load side by side.
  const [watched, found] = (await Promise.all([watchedP, foundP])).map((x) => x.flat())

  const seen = new Set<string>()
  const posts = [...watched, ...found]
    .filter((p) => p.authorId !== me && !done[`post:${p.socialId}`])
    .filter((p) => (seen.has(p.socialId) ? false : (seen.add(p.socialId), true)))
  // Watchlist first (newest first), then topic posts by engagement, newer ones weighted up.
  const age = (p: FeedPost) => Math.max(1, (Date.now() - Date.parse(p.date)) / 3_600_000)
  const score = (p: FeedPost) => (p.reactions + 3 * p.comments) / Math.sqrt(age(p))
  posts.sort((a, b) =>
    a.source !== b.source ? (a.source === 'watchlist' ? -1 : 1) : a.source === 'watchlist' ? b.date.localeCompare(a.date) : score(b) - score(a),
  )
  return json({ settings, posts: posts.slice(0, 60), errors })
}

const Settings = z.object({
  watchlist: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        profileId: z.string().regex(/^(AC|AD)[A-Za-z0-9_-]+$/),
        headline: z.string().max(400).optional(),
        picture: z.string().url().startsWith('https://').max(2000).optional(),
        url: z.string().url().startsWith('https://').max(500).optional(),
      }),
    )
    .max(40),
  topics: z.array(z.string().trim().min(2).max(80)).max(8),
  minReactions: z.number().int().min(0).max(5000),
})

/** PUT /api/engage {watchlist, topics, minReactions} -> saves what the Comments tab looks at. */
export async function PUT(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const parsed = Settings.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'Bad settings' }, 400)
  await mutate((s) => {
    s.engage = parsed.data
  })
  return json({ ok: true })
}
