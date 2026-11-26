import { z } from 'zod'
import { type EngageSettings, type State, json, mutate, readState, requireAuth } from './_lib.js'
import { config, unipile } from './_publish.js'
import { PERSON_ID, buildStats, suggest } from './_engagement.js'
import { type FeedPost, type RawPost, toFeed } from './_circle.js'

// The Comments tab. Two views:
// - feed: what your circle posted, liked or commented on (built by the cron in api/_circle.ts), only
//   posts already getting traction, ranked by momentum. Read from the cache, so it's instant.
// - more: live searches. Topics, plus "popular in your sector" (no keywords, filtered by author
//   industry), plus who to follow.

export const defaultEngage = (): EngageSettings => ({ watchlist: [], topics: [], minReactions: 25 })

/** Feed and sector posts must be this fresh. */
const FEED_WINDOW_MS = 48 * 3600_000

type Cfg = NonNullable<ReturnType<typeof config>>

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** Gives up on one slow call so the whole tab still loads. */
const within = <T,>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

const search = (c: Cfg, body: Record<string, unknown>) =>
  unipile<{ items?: RawPost[] }>(c, `/api/v1/linkedin/search?account_id=${encodeURIComponent(c.account)}&limit=50`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: 'classic', category: 'posts', ...body }),
  }).then((r) => r.items ?? [])

/** People who engage with you, or engaged back after you commented: their posts rank higher. */
function warmSet(s: State) {
  const stats = buildStats(s)
  return new Set([
    ...(s.engagers?.people ?? []).map((p) => p.id),
    ...Object.entries(stats.byPerson)
      .filter(([, x]) => x.authorReplied + x.authorLiked + x.engagedBack > 0)
      .map(([id]) => id),
  ])
}

/**
 * Momentum: engagement so far over the square root of hours since posting, so a post taking off now
 * beats a bigger one from yesterday. Up to double for every extra circle person on it, doubled again
 * for people who engage with you.
 */
function rank(posts: FeedPost[], warm: Set<string>) {
  const age = (p: FeedPost) => Math.max(1, (Date.now() - Date.parse(p.date)) / 3_600_000)
  const people = (p: FeedPost) => new Set((p.via ?? []).map((v) => v.id)).size
  const score = (p: FeedPost) =>
    ((p.reactions + 3 * p.comments) / Math.sqrt(age(p))) *
    (1 + 0.5 * Math.min(2, Math.max(0, people(p) - 1))) *
    (p.authorId && warm.has(p.authorId) ? 2 : 1)
  return posts.sort((a, b) => score(b) - score(a))
}

/** GET /api/engage            -> the circle feed (instant)
 *  GET /api/engage?view=more  -> topic and sector searches, suggestions (slow, live)
 *  GET /api/engage?industry=q -> LinkedIn industries matching q, for the sector picker */
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const c = config()
  if (!c) return json({ error: 'Unipile is not configured' }, 503)
  const url = new URL(req.url)
  const s = await readState()
  const settings = s.engage ?? defaultEngage()
  const done = s.replied ?? {}
  const me = s.analytics?.providerId
  const feedMin = settings.feedMinReactions ?? 30
  const fresh = (p: FeedPost) => Date.now() - Date.parse(p.date) <= FEED_WINDOW_MS
  const open = (p: FeedPost) => p.authorId !== me && !done[`post:${p.socialId}`]

  const q = url.searchParams.get('industry')
  if (q !== null) {
    if (q.trim().length < 2) return json({ results: [] })
    try {
      const r = await within(
        15_000,
        unipile<{ items?: { id: string; title: string }[] }>(
          c,
          `/api/v1/linkedin/search/parameters?account_id=${encodeURIComponent(c.account)}&type=INDUSTRY&limit=10&keywords=${encodeURIComponent(q.trim().slice(0, 80))}`,
        ),
      )
      return json({ results: (r.items ?? []).map((x) => ({ id: String(x.id), title: x.title })) })
    } catch {
      return json({ error: 'Could not search industries' }, 502)
    }
  }

  if (url.searchParams.get('view') === 'more') {
    const errors: string[] = []
    const foundP = inBatches(settings.topics, 4, async (t) => {
      try {
        return (await within(30_000, search(c, { keywords: t, date_posted: 'past_week', sort_by: 'relevance' })))
          .map((p) => toFeed(p, 'topic', t))
          .filter((p): p is FeedPost => !!p && p.reactions >= settings.minReactions)
      } catch {
        errors.push(`Couldn't search "${t}"`)
        return []
      }
    })
    const industries = settings.industries ?? []
    const sectorP = industries.length
      ? within(30_000, search(c, { date_posted: 'past_day', sort_by: 'relevance', author: { industry: industries.map((i) => i.id) } }))
          .then((items) => items.map((p) => toFeed(p, 'sector')).filter((p): p is FeedPost => !!p && p.reactions >= feedMin && fresh(p)))
          .catch(() => {
            errors.push('Couldn\'t search your sector')
            return [] as FeedPost[]
          })
      : Promise.resolve([] as FeedPost[])
    const [found, sector] = await Promise.all([foundP.then((x) => x.flat()), sectorP])
    const seen = new Set<string>()
    const warm = warmSet(s)
    const posts = rank(
      [...sector, ...found].filter(open).filter((p) => (seen.has(p.socialId) ? false : (seen.add(p.socialId), true))),
      warm,
    )
    const now = await readState()
    return json({ posts: posts.slice(0, 80), errors, suggestions: suggest(now, settings, found) })
  }

  const cached = s.circlePosts ?? []
  const posts = rank(cached.filter((p) => fresh(p) && open(p) && p.reactions >= feedMin), warmSet(s))
  const people = s.circle?.people ?? []
  const day = Date.now() - 86_400_000
  return json({
    settings,
    posts: posts.slice(0, 100),
    errors: s.circle?.error ? [s.circle.error] : [],
    stats: buildStats(s),
    engagersAt: s.engagers?.fetchedAt ?? null,
    circle: {
      builtAt: s.circle?.builtAt ?? null,
      size: people.length,
      checkedToday: people.filter((p) => p.checkedAt && Date.parse(p.checkedAt) >= day).length,
      cached: cached.filter(fresh).length,
      minReactions: feedMin,
      people: people.map(({ id, name, headline, picture, url, why }) => ({ id, name, headline, picture, url, why })),
    },
  })
}

const Dismiss = z.union([z.object({ dismiss: z.string().regex(PERSON_ID) }), z.object({ exclude: z.string().regex(PERSON_ID) })])

/** POST /api/engage {dismiss: id} -> never suggest them again. {exclude: id} -> take them out of your circle for good. */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const parsed = Dismiss.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'Bad request' }, 400)
  const body = parsed.data
  await mutate((s) => {
    if ('dismiss' in body) {
      const d = new Set(s.engageDismissed ?? [])
      d.add(body.dismiss)
      s.engageDismissed = [...d].slice(-1000)
    } else {
      const x = new Set(s.circleExcluded ?? [])
      x.add(body.exclude)
      s.circleExcluded = [...x].slice(-2000)
      if (s.circle) s.circle.people = s.circle.people.filter((p) => p.id !== body.exclude)
      // Their own posts leave the feed too; posts they only liked stay if others touched them.
      if (s.circlePosts)
        s.circlePosts = s.circlePosts
          .map((p) => ({ ...p, via: p.via?.filter((v) => v.id !== body.exclude) }))
          .filter((p) => p.authorId !== body.exclude && (p.via?.length ?? 0) > 0)
    }
  })
  return json({ ok: true })
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
  network: z.object({ connections: z.boolean(), following: z.boolean() }).optional(),
  feedMinReactions: z.number().int().min(0).max(5000).optional(),
  industries: z.array(z.object({ id: z.string().regex(/^\d+$/), title: z.string().min(1).max(120) })).max(5).optional(),
})

/** PUT /api/engage {watchlist, topics, minReactions} -> saves what the Comments tab looks at. */
export async function PUT(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const parsed = Settings.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'Bad settings' }, 400)
  await mutate((s) => {
    s.engage = parsed.data
    // Adding someone to "always in your circle" overrides an earlier removal.
    const keep = new Set(parsed.data.watchlist.map((w) => w.profileId))
    if (s.circleExcluded) s.circleExcluded = s.circleExcluded.filter((id) => !keep.has(id))
  })
  return json({ ok: true })
}
