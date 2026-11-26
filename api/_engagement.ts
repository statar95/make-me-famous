import {
  type CommentOutcome,
  type Engager,
  type EngageSettings,
  type LoggedComment,
  type State,
  mutate,
  readState,
} from './_lib.js'
import { config, unipile } from './_publish.js'

// The learning loop behind the Comments tab:
// 1. Who engages with your own posts (refreshed daily) -> people to follow, and "did they engage back".
// 2. How each comment you made landed (checked over two weeks) -> who and what is worth your time.

type Cfg = NonNullable<ReturnType<typeof config>>

const DAY = 86_400_000
const ENGAGERS_EVERY_MS = DAY
const ENGAGERS_BACKOFF_MS = 30 * 60_000
/** Your last 12 posts from up to this far back count towards "who engages with you". */
const ENGAGERS_WINDOW_MS = 180 * DAY
const ENGAGERS_MAX_POSTS = 12
const ENGAGERS_KEEP = 300

const OUTCOMES_EVERY_MS = 30 * 60_000
/** First look once a comment has had time to land; keep looking for two weeks. */
const OUTCOME_FIRST_MS = 2 * 3600_000
const OUTCOME_RECHECK_MS = 12 * 3600_000
const OUTCOME_WINDOW_MS = 14 * DAY
/** Per cron run, so a busy week can't run the cron into its time limit or Unipile's rate limit. */
const OUTCOMES_PER_RUN = 6

export const LOG_KEEP = 400

/** Only these are LinkedIn member ids the watchlist accepts. */
export const PERSON_ID = /^(AC|AD)[A-Za-z0-9_-]+$/

interface RawComment {
  id?: string
  date?: string
  author?: string | null
  reply_counter?: number
  reaction_counter?: number
  author_details?: {
    id?: string | null
    headline?: string | null
    profile_url?: string | null
    profile_picture_url?: string | null
  }
}
interface RawReaction {
  author?: {
    id?: string
    type?: 'INDIVIDUAL' | 'COMPANY'
    name?: string | null
    headline?: string | null
    profile_url?: string | null
    profile_picture_url?: string | null
  }
}

const acct = (c: Cfg) => encodeURIComponent(c.account)
const comments = (c: Cfg, socialId: string, commentId?: string) =>
  unipile<{ items?: RawComment[] }>(
    c,
    `/api/v1/posts/${encodeURIComponent(socialId)}/comments?account_id=${acct(c)}&limit=100${
      commentId ? `&comment_id=${encodeURIComponent(commentId)}` : ''
    }`,
  ).then((r) => r.items ?? [])
const reactions = (c: Cfg, socialId: string, commentId?: string) =>
  unipile<{ items?: RawReaction[] }>(
    c,
    `/api/v1/posts/${encodeURIComponent(socialId)}/reactions?account_id=${acct(c)}&limit=100${
      commentId ? `&comment_id=${encodeURIComponent(commentId)}` : ''
    }`,
  ).then((r) => r.items ?? [])

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

// ---- 1. Who engages with your posts ----

/** Re-reads who reacted to and commented on your recent posts, once a day. Never throws. */
export async function refreshEngagers(): Promise<{ ran: boolean; people?: number; error?: string }> {
  const c = config()
  if (!c) return { ran: false, error: 'Unipile is not configured' }
  const now = Date.now()
  const due = (s: State) =>
    !!s.analytics?.providerId &&
    !(s.engagers?.fetchedAt && now - Date.parse(s.engagers.fetchedAt) < ENGAGERS_EVERY_MS) &&
    !(s.engagers?.attemptedAt && now - Date.parse(s.engagers.attemptedAt) < ENGAGERS_BACKOFF_MS)
  if (!due(await readState())) return { ran: false }

  // Claim the run, so two cron runs never both do it.
  let go = false
  const s0 = await mutate((s) => {
    go = due(s)
    if (go) s.engagers = { ...(s.engagers ?? { posts: 0, people: [] }), attemptedAt: new Date(now).toISOString() }
  })
  if (!go) return { ran: false }

  const me = s0.analytics!.providerId!
  const mine = (s0.analytics?.posts ?? [])
    .filter((p) => p.socialId && now - Date.parse(p.date) <= ENGAGERS_WINDOW_MS)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, ENGAGERS_MAX_POSTS)

  const people = new Map<string, Engager>()
  const touch = (id: string, who: Omit<Engager, 'id' | 'comments' | 'reactions' | 'on'>, postDate: string, kind: 'comments' | 'reactions') => {
    if (id === me || !PERSON_ID.test(id)) return
    const p = people.get(id) ?? { id, ...who, comments: 0, reactions: 0, on: [] }
    p[kind]++
    if (!p.on.includes(postDate)) p.on.push(postDate)
    people.set(id, p)
  }
  let failed = 0
  await inBatches(mine, 3, async (post) => {
    const [cs, rs] = await Promise.allSettled([comments(c, post.socialId!), reactions(c, post.socialId!)])
    if (cs.status === 'fulfilled')
      for (const x of cs.value) {
        const id = x.author_details?.id
        if (id)
          touch(
            id,
            {
              name: x.author ?? 'Someone',
              headline: x.author_details?.headline ?? undefined,
              picture: x.author_details?.profile_picture_url ?? undefined,
              url: x.author_details?.profile_url ?? undefined,
            },
            post.date,
            'comments',
          )
      }
    else failed++
    if (rs.status === 'fulfilled')
      for (const x of rs.value) {
        const a = x.author
        if (a?.id && a.type !== 'COMPANY')
          touch(
            a.id,
            {
              name: a.name ?? 'Someone',
              headline: a.headline ?? undefined,
              picture: a.profile_picture_url ?? undefined,
              url: a.profile_url ?? undefined,
            },
            post.date,
            'reactions',
          )
      }
    else failed++
  })

  // Every call failing means Unipile is down, not that nobody engages: keep the old list.
  if (mine.length && failed > Math.max(2, mine.length / 2)) {
    const error = 'Could not read who engages with your posts'
    await mutate((s) => {
      s.engagers = { ...(s.engagers ?? { posts: 0, people: [] }), error }
    })
    return { ran: true, error }
  }
  const ranked = [...people.values()]
    .map((p) => ({ ...p, on: p.on.sort((a, b) => b.localeCompare(a)) }))
    .sort((a, b) => 3 * b.comments + b.reactions - (3 * a.comments + a.reactions))
    .slice(0, ENGAGERS_KEEP)
  await mutate((s) => {
    s.engagers = {
      fetchedAt: new Date().toISOString(),
      attemptedAt: s.engagers?.attemptedAt,
      posts: mine.length,
      people: ranked,
      ...(failed ? { error: `${failed} of ${mine.length * 2} reads failed; list may be short` } : {}),
    }
  })
  return { ran: true, people: ranked.length }
}

// ---- 2. How your comments landed ----

const outcomeDue = (l: LoggedComment, now: number) => {
  const age = now - Date.parse(l.at)
  if (age < OUTCOME_FIRST_MS || l.outcome?.missing) return false
  const last = l.outcome ? Date.parse(l.outcome.checkedAt) : 0
  // One last look just after the window closes, then it's final.
  if (last - Date.parse(l.at) > OUTCOME_WINDOW_MS) return false
  return now - last >= OUTCOME_RECHECK_MS
}

/** Busy posts have more than one page of comments; look through a few for yours. */
async function findMine(c: Cfg, me: string, l: LoggedComment): Promise<RawComment | undefined> {
  let cursor: string | null = null
  for (let page = 0; page < 5; page++) {
    const r: { items?: RawComment[]; cursor?: string | null } = await unipile(
      c,
      `/api/v1/posts/${encodeURIComponent(l.socialId)}/comments?account_id=${acct(c)}&limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    )
    // By id if we have it, else (or if the id format differs) by you being the author.
    const hit = (r.items ?? []).find((x) => (l.commentId && x.id === l.commentId) || x.author_details?.id === me)
    if (hit) return hit
    cursor = r.cursor ?? null
    if (!cursor) return undefined
  }
  return undefined
}

async function checkOne(c: Cfg, me: string, l: LoggedComment): Promise<CommentOutcome | null> {
  let mine: RawComment | undefined
  try {
    mine = await findMine(c, me, l)
  } catch {
    return null // Try again next time; a failed read is not a deleted comment.
  }
  const checkedAt = new Date().toISOString()
  if (!mine?.id) {
    // One miss can be a hiccup. Only the second in a row counts as gone; keep any earlier numbers.
    const misses = (l.outcome?.misses ?? 0) + 1
    const prev = l.outcome ?? { likes: 0, replies: 0, authorReplied: false, authorLiked: false }
    return { ...prev, checkedAt, misses, missing: misses >= 2 }
  }

  let authorReplied = false
  let authorLiked = false
  if (l.authorId && (mine.reply_counter ?? 0) > 0) {
    try {
      authorReplied = (await comments(c, l.socialId, mine.id)).some((r) => r.author_details?.id === l.authorId)
    } catch {
      return null
    }
  }
  if (l.authorId && (mine.reaction_counter ?? 0) > 0) {
    try {
      authorLiked = (await reactions(c, l.socialId, mine.id)).some((r) => r.author?.id === l.authorId)
    } catch {
      return null
    }
  }
  return { checkedAt, likes: mine.reaction_counter ?? 0, replies: mine.reply_counter ?? 0, authorReplied, authorLiked }
}

/** Checks a few logged comments that are due a look. Runs from the cron every 30 minutes. Never throws. */
export async function checkOutcomes(): Promise<{ checked: number }> {
  const c = config()
  if (!c) return { checked: 0 }
  const now = Date.now()
  const due0 = (s: State) =>
    !!s.analytics?.providerId &&
    !!s.commentLog?.some((l) => outcomeDue(l, now)) &&
    !(s.outcomesAt && now - Date.parse(s.outcomesAt) < OUTCOMES_EVERY_MS)
  // Read first: most runs have nothing due, and those shouldn't rewrite the state blob.
  if (!due0(await readState())) return { checked: 0 }
  let go = false
  const s0 = await mutate((s) => {
    go = due0(s)
    if (go) s.outcomesAt = new Date(now).toISOString()
  })
  if (!go) return { checked: 0 }

  const me = s0.analytics!.providerId!
  const lastLook = (l: LoggedComment) => (l.outcome ? Date.parse(l.outcome.checkedAt) : 0)
  const due = s0
    .commentLog!.filter((l) => outcomeDue(l, now))
    .sort((a, b) => lastLook(a) - lastLook(b))
    .slice(0, OUTCOMES_PER_RUN)
  const results = await inBatches(due, 2, async (l) => ({ socialId: l.socialId, outcome: await checkOne(c, me, l) }))
  const found = results.filter((r): r is { socialId: string; outcome: CommentOutcome } => !!r.outcome)
  if (found.length)
    await mutate((s) => {
      for (const r of found) {
        const l = s.commentLog?.find((x) => x.socialId === r.socialId)
        if (l) l.outcome = r.outcome
      }
    })
  return { checked: found.length }
}

// ---- What the Comments tab shows: scores and suggestions ----

export interface Score {
  comments: number
  /** Comments old enough to have a result. */
  measured: number
  avgLikes: number
  authorReplied: number
  authorLiked: number
  /** They later reacted to or commented on one of your posts. */
  engagedBack: number
}
export interface Stats {
  total: number
  byPerson: Record<string, Score & { name: string }>
  byTopic: Record<string, Score>
  watchlist: Score
  feed: Score
}

const blank = (): Score => ({ comments: 0, measured: 0, avgLikes: 0, authorReplied: 0, authorLiked: 0, engagedBack: 0 })

/** Did this person engage with a post of yours published after you commented on theirs? */
const engagedAfter = (s: State, l: LoggedComment) => {
  if (!l.authorId) return false
  const p = s.engagers?.people.find((x) => x.id === l.authorId)
  return !!p?.on.some((d) => d > l.at)
}

export function buildStats(s: State): Stats {
  const byPerson: Stats['byPerson'] = {}
  const byTopic: Stats['byTopic'] = {}
  const watchlist = blank()
  const feed = blank()
  const likes = new Map<Score, number>()
  const add = (sc: Score, l: LoggedComment) => {
    sc.comments++
    if (l.outcome && !l.outcome.missing) {
      sc.measured++
      likes.set(sc, (likes.get(sc) ?? 0) + l.outcome.likes)
      if (l.outcome.authorReplied) sc.authorReplied++
      if (l.outcome.authorLiked) sc.authorLiked++
    }
    if (engagedAfter(s, l)) sc.engagedBack++
  }
  for (const l of s.commentLog ?? []) {
    if (l.authorId) add((byPerson[l.authorId] ??= { ...blank(), name: l.author }), l)
    if (l.source === 'topic' && l.topic) add((byTopic[l.topic] ??= blank()), l)
    if (l.source === 'watchlist') add(watchlist, l)
    if (l.source === 'feed') add(feed, l)
    if (l.source === 'sector') add((byTopic['Popular in your sector'] ??= blank()), l)
  }
  for (const [sc, n] of likes) sc.avgLikes = sc.measured ? Math.round((n / sc.measured) * 10) / 10 : 0
  return { total: s.commentLog?.length ?? 0, byPerson, byTopic, watchlist, feed }
}

export interface Suggestion {
  profileId: string
  name: string
  headline?: string
  picture?: string
  url?: string
  why: 'engages-with-you' | 'topic-author'
  reason: string
  score: number
}

interface TopicPost {
  authorId?: string
  author: string
  headline?: string
  picture?: string
  reactions: number
  topic?: string
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * People worth adding to the watchlist: those who already engage with your posts (most likely to
 * engage back), and authors who keep turning up in your topic searches with real engagement.
 */
export function suggest(s: State, settings: EngageSettings, topicPosts: TopicPost[]): Suggestion[] {
  const skip = new Set([...settings.watchlist.map((w) => w.profileId), ...(s.engageDismissed ?? [])])
  if (s.analytics?.providerId) skip.add(s.analytics.providerId)
  const out = new Map<string, Suggestion>()

  for (const p of s.engagers?.people ?? []) {
    if (skip.has(p.id) || !PERSON_ID.test(p.id)) continue
    // A couple of likes isn't a pattern. A comment, or three posts' worth of reactions, is.
    if (p.comments < 1 && p.on.length < 3) continue
    const bits = [p.comments && `commented ${plural(p.comments, 'time')}`, p.reactions && `reacted ${plural(p.reactions, 'time')}`].filter(Boolean)
    out.set(p.id, {
      profileId: p.id,
      name: p.name,
      headline: p.headline,
      picture: p.picture,
      url: p.url,
      why: 'engages-with-you',
      reason: `${bits.join(', ')} on ${plural(p.on.length, 'post')} of yours`,
      score: 3 * p.comments + p.reactions,
    })
  }

  const authors = new Map<string, { a: TopicPost; posts: number; reactions: number; topics: Set<string> }>()
  for (const p of topicPosts) {
    if (!p.authorId || skip.has(p.authorId) || !PERSON_ID.test(p.authorId)) continue
    const e = authors.get(p.authorId) ?? { a: p, posts: 0, reactions: 0, topics: new Set<string>() }
    e.posts++
    e.reactions += p.reactions
    if (p.topic) e.topics.add(p.topic)
    authors.set(p.authorId, e)
  }
  const bigPost = Math.max(150, 4 * settings.minReactions)
  for (const [id, e] of authors) {
    if (out.has(id) || (e.posts < 2 && e.reactions < bigPost)) continue
    out.set(id, {
      profileId: id,
      name: e.a.author,
      headline: e.a.headline,
      picture: e.a.picture,
      why: 'topic-author',
      reason: `${plural(e.posts, 'post')} on ${[...e.topics].map((t) => `"${t}"`).join(', ')} this week, ${e.reactions} reactions`,
      // Ranked below people who already engage with you unless they're clearly big.
      score: Math.min(10, e.posts * 2 + e.reactions / 200),
    })
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 12)
}
