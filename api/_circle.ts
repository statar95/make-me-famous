import { type CirclePerson, type State, mutate, readState } from './_lib.js'
import { config, unipile } from './_publish.js'
import { PERSON_ID } from './_engagement.js'

// "What your circle is engaging with": LinkedIn's home feed is mostly posts by people you know plus
// posts they liked or commented on. There is no API for that feed, so the cron rebuilds it slowly:
// a circle of ~150 people, a couple checked per run, and every post they posted, liked or commented
// on goes into a cache. The Comments tab reads the cache, so it loads instantly.

type Cfg = NonNullable<ReturnType<typeof config>>

// ---- Shared post shape (also used by api/engage.ts) ----

export interface RawPost {
  id?: string
  social_id?: string
  text?: string
  parsed_datetime?: string
  date?: string
  share_url?: string
  reaction_counter?: number
  comment_counter?: number
  is_repost?: boolean
  /** On a repost: the original post. */
  repost_content?: { id?: string }
  permissions?: { can_post_comments?: boolean }
  author?: { id?: string; name?: string; headline?: string; profile_picture_url?: string; public_identifier?: string; is_company?: boolean }
}

export interface Via {
  id: string
  name: string
  kind: 'posted' | 'liked' | 'commented'
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
  source: 'watchlist' | 'topic' | 'feed' | 'sector'
  topic?: string
  /** Circle feed: who in your circle posted, liked or commented on it. */
  via?: Via[]
  /** Circle feed: when reactions/comments were last read. */
  countsAt?: string
}

export const toFeed = (p: RawPost, source: FeedPost['source'], topic?: string): FeedPost | null => {
  if (!p.social_id || !p.text || p.is_repost || p.permissions?.can_post_comments === false) return null
  return {
    socialId: p.social_id,
    url: p.share_url,
    date: p.parsed_datetime ?? p.date ?? '',
    text: p.text.slice(0, 3000),
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

// ---- Knobs. Start slow: this is the app's heaviest LinkedIn traffic. ----

const HOUR = 3600_000
export const CIRCLE_MAX = 150
const CIRCLE_REBUILD_MS = 24 * HOUR
const CIRCLE_BACKOFF_MS = 30 * 60_000
/** One circle run every 15 minutes: 96 a day. */
const RUN_EVERY_MS = 15 * 60_000
/** People checked per run. 2 x 96 = 192 a day, so each of 150 people about once a day. */
const PEOPLE_PER_RUN = 2
/** Don't re-check a person sooner than this. */
const PERSON_EVERY_MS = 20 * HOUR
/** New posts read in full per run (a like only tells us the post id). */
const NEW_POSTS_PER_RUN = 4
/** Cached posts whose counts get refreshed per run. */
const REFRESHES_PER_RUN = 1
const REFRESH_EVERY_MS = 3 * HOUR
/** Posts older than this leave the cache. */
export const CACHE_WINDOW_MS = 72 * HOUR
const CACHE_MAX = 500
/** Messages older than this don't put someone in your circle. */
const MESSAGE_WINDOW_MS = 90 * 24 * HOUR

/** Per call, and for the whole circle step, so the cron (120s, publishing first) never runs out of time. */
const CALL_MS = 12_000
const POLL_BUDGET_MS = 45_000
const MAX_FAILURES = 3

const acct = (c: Cfg) => encodeURIComponent(c.account)
const within = <T,>(ms: number, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])

/** GET /posts/{id} wants the bare number for activity posts and the full urn for ugcPost/share. */
export function postKey(id: string) {
  const m = /^urn:li:activity:(\d+)$/.exec(id)
  return m ? m[1] : id
}

/**
 * LinkedIn ids carry their creation time: the top bits are milliseconds since 1970. Lets us skip old
 * posts someone liked without spending a read on them. Null if the id isn't a LinkedIn number.
 */
export function idTime(id: string): number | null {
  const m = /(\d{15,})$/.exec(id)
  if (!m) return null
  const ms = Number(BigInt(m[1]) >> 22n)
  return ms > Date.parse('2010-01-01') && ms < Date.now() + 86_400_000 ? ms : null
}

// ---- 1. Who is in the circle (daily) ----

interface RawChat {
  attendee_provider_id?: string
  name?: string | null
  type?: number
  timestamp?: string | null
}

/** Rebuilds the circle once a day: watchlist, people who engage with you, people you message, and frequent posters. Never throws. */
export async function rebuildCircle(): Promise<{ ran: boolean; people?: number; error?: string }> {
  const c = config()
  if (!c) return { ran: false }
  const now = Date.now()
  const due = (s: State) =>
    !!s.analytics?.providerId &&
    !(s.circle?.builtAt && now - Date.parse(s.circle.builtAt) < CIRCLE_REBUILD_MS) &&
    !(s.circle?.attemptedAt && now - Date.parse(s.circle.attemptedAt) < CIRCLE_BACKOFF_MS)
  if (!due(await readState())) return { ran: false }
  let go = false
  const s0 = await mutate((s) => {
    go = due(s)
    if (go) s.circle = { ...(s.circle ?? { people: [] }), attemptedAt: new Date(now).toISOString() }
  })
  if (!go) return { ran: false }

  const me = s0.analytics!.providerId!
  const out = new Set(s0.circleExcluded ?? [])
  out.add(me)
  const people = new Map<string, CirclePerson>()
  const add = (p: Omit<CirclePerson, 'why' | 'checkedAt'>, why: CirclePerson['why'][number]) => {
    if (out.has(p.id) || !PERSON_ID.test(p.id)) return
    const e = people.get(p.id)
    if (e) {
      if (!e.why.includes(why)) e.why.push(why)
      return
    }
    if (people.size >= CIRCLE_MAX) return
    people.set(p.id, { ...p, why: [why] })
  }

  // Order is priority: the cap cuts from the end.
  for (const w of s0.engage?.watchlist ?? []) add({ id: w.profileId, name: w.name, headline: w.headline, picture: w.picture, url: w.url }, 'watchlist')
  for (const p of (s0.engagers?.people ?? []).slice(0, 80)) add({ id: p.id, name: p.name, headline: p.headline, picture: p.picture, url: p.url }, 'engager')

  let error: string | undefined
  try {
    const chats = await within(15_000, unipile<{ items?: RawChat[] }>(c, `/api/v1/chats?account_type=LINKEDIN&account_id=${acct(c)}&limit=100`))
    ;(chats.items ?? [])
      .filter((x) => x.attendee_provider_id && x.timestamp && now - Date.parse(x.timestamp) < MESSAGE_WINDOW_MS)
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
      .slice(0, 50)
      .forEach((x) => add({ id: x.attendee_provider_id!, name: x.name ?? 'Someone' }, 'message'))
  } catch (e) {
    error = 'Could not read your LinkedIn messages'
    console.error('[circle] chats', e instanceof Error ? e.message : e)
  }
  // Authors who keep turning up in your cached feed.
  const posts = new Map<string, { n: number; p: CirclePerson }>()
  for (const p of s0.circlePosts ?? [])
    if (p.authorId) {
      const e = posts.get(p.authorId) ?? { n: 0, p: { id: p.authorId, name: p.author, headline: p.headline, picture: p.picture, why: [] } }
      e.n++
      posts.set(p.authorId, e)
    }
  ;[...posts.values()]
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .forEach((x) => add({ id: x.p.id, name: x.p.name, headline: x.p.headline, picture: x.p.picture }, 'poster'))

  await mutate((s) => {
    // Keep when each person was last checked, so a rebuild doesn't reset the rotation.
    const checked = new Map((s.circle?.people ?? []).map((p) => [p.id, p.checkedAt]))
    const excluded = new Set(s.circleExcluded ?? [])
    s.circle = {
      builtAt: new Date().toISOString(),
      attemptedAt: s.circle?.attemptedAt,
      // A rebuild gives people who kept failing a fresh start (failures reset).
      people: [...people.values()].filter((p) => !excluded.has(p.id)).map((p) => ({ ...p, checkedAt: checked.get(p.id) })),
      ...(error ? { error } : {}),
    }
  })
  return { ran: true, people: people.size, error }
}

// ---- 2. What the circle is doing (every 15 minutes, a couple of people at a time) ----

interface RawUserComment {
  post_id?: string
  post_urn?: string
}
interface RawUserReaction {
  post_id?: string
  comment_id?: string
}

const readPost = (c: Cfg, key: string) =>
  within(CALL_MS, unipile<RawPost>(c, `/api/v1/posts/${encodeURIComponent(key)}?account_id=${acct(c)}`))
/** A bare number may be an activity id or a ugcPost id; the endpoint wants the urn for the latter. */
async function getPost(c: Cfg, id: string) {
  try {
    return await readPost(c, postKey(id))
  } catch (e) {
    if (/^\d+$/.test(id)) return readPost(c, `urn:li:ugcPost:${id}`)
    throw e
  }
}

/** Checks the next couple of circle people and updates the post cache. Never throws. */
export async function pollCircle(): Promise<{ checked: number; added: number; refreshed: number }> {
  const none = { checked: 0, added: 0, refreshed: 0 }
  const c = config()
  if (!c) return none
  const now = Date.now()
  const dueRun = (s: State) =>
    !!s.circle?.people.length && !(s.circleRunAt && now - Date.parse(s.circleRunAt) < RUN_EVERY_MS)
  if (!dueRun(await readState())) return none
  const started = Date.now()
  const lastCheck = (p: CirclePerson) => (p.checkedAt ? Date.parse(p.checkedAt) : 0)
  // Watchlist people first among those due, then whoever has waited longest.
  const pick = (s: State) =>
    (s.circle?.people ?? [])
      .filter((p) => now - lastCheck(p) >= PERSON_EVERY_MS)
      .sort((a, b) => Number(b.why.includes('watchlist')) - Number(a.why.includes('watchlist')) || lastCheck(a) - lastCheck(b))
      .slice(0, PEOPLE_PER_RUN)
  let go = false
  let who: CirclePerson[] = []
  const s0 = await mutate((s) => {
    // Reposts used to be skipped; now they're followed to the original, so give those posts another try.
    if (s.circleSkipV !== 2) {
      s.circleSkip = {}
      s.circleSkipWhy = {}
      s.circleSkipV = 2
    }
    go = dueRun(s)
    who = []
    if (!go) return
    s.circleRunAt = new Date(now).toISOString()
    // Mark them attempted now: if this run dies, they still wait their turn instead of being retried every run.
    who = pick(s).map((p) => ({ ...p }))
    const ids = new Set(who.map((p) => p.id))
    for (const p of s.circle!.people) if (ids.has(p.id)) p.checkedAt = new Date(now).toISOString()
  })
  if (!go) return none
  const skip = s0.circleSkip ?? {}
  const skipped = (id: string) => {
    const until = skip[postKey(id)]
    return !!until && Date.parse(until) > now
  }
  const overBudget = () => Date.now() - started > POLL_BUDGET_MS

  const cache = new Map((s0.circlePosts ?? []).map((p) => [p.socialId, p]))
  const newPosts: FeedPost[] = []
  /** Post id -> who touched it, for posts we only know by id. */
  const pending = new Map<string, Via[]>()
  const touches: { socialId: string; via: Via }[] = []
  const checkedOk: string[] = []
  const failed: string[] = []
  /** Ids read this run that turned out unusable: don't read them again for 72h. */
  const unusable: string[] = []
  const why: Record<string, string> = {}
  const reason = (r: RawPost) =>
    r.is_repost ? 'repost' : r.permissions?.can_post_comments === false ? 'comments off' : !r.text ? 'no text' : !r.social_id ? 'no social_id' : 'too old'
  const cutoff = now - CACHE_WINDOW_MS
  const byKey = new Map([...cache.values()].map((p) => [postKey(p.socialId), p.socialId]))
  const known = (id: string) => cache.get(id)?.socialId ?? byKey.get(postKey(id))
  /** Per person, their unknown refs in order, so the read budget is shared fairly. */
  const queues: string[][] = []

  for (const p of who) {
    const base = `/api/v1/users/${encodeURIComponent(p.id)}`
    if (overBudget()) break
    const [posts, reactions, comments] = await Promise.allSettled([
      within(CALL_MS, unipile<{ items?: RawPost[] }>(c, `${base}/posts?account_id=${acct(c)}&limit=5`)),
      within(CALL_MS, unipile<{ items?: RawUserReaction[] }>(c, `${base}/reactions?account_id=${acct(c)}&limit=15`)),
      within(CALL_MS, unipile<{ items?: RawUserComment[] }>(c, `${base}/comments?account_id=${acct(c)}&limit=10`)),
    ])
    if ([posts, reactions, comments].some((r) => r.status === 'fulfilled')) checkedOk.push(p.id)
    else failed.push(p.id)
    if (posts.status === 'fulfilled')
      for (const raw of posts.value.items ?? []) {
        const f = toFeed(raw, 'feed')
        if (!f || Date.parse(f.date) < cutoff) continue
        const via: Via = { id: p.id, name: p.name, kind: 'posted' }
        const k = known(f.socialId)
        if (k) touches.push({ socialId: k, via })
        else {
          const n: FeedPost = { ...f, via: [via], countsAt: new Date().toISOString() }
          newPosts.push(n)
          // So someone else's like on it later this run attaches instead of costing a read.
          cache.set(n.socialId, n)
          byKey.set(postKey(n.socialId), n.socialId)
        }
      }
    const mine: string[] = []
    const refs: [string | undefined, Via['kind']][] = [
      ...(reactions.status === 'fulfilled' ? (reactions.value.items ?? []).filter((r) => !r.comment_id).map((r) => [r.post_id, 'liked'] as [string | undefined, Via['kind']]) : []),
      ...(comments.status === 'fulfilled' ? (comments.value.items ?? []).map((r) => [r.post_urn ?? r.post_id, 'commented'] as [string | undefined, Via['kind']]) : []),
    ]
    for (const [id, kind] of refs) {
      if (!id || skipped(id)) continue
      // Older than the cache window, going by the time inside the id: not worth a read.
      const t = idTime(id)
      if (t !== null && t < cutoff) continue
      const via: Via = { id: p.id, name: p.name, kind }
      const k = known(id)
      if (k) touches.push({ socialId: k, via })
      else {
        if (!pending.has(id)) mine.push(id)
        pending.set(id, [...(pending.get(id) ?? []), via])
      }
    }
    queues.push(mine)
  }

  // Read a few unknown posts in full: ones several people touched first, then taking turns per person.
  const order: string[] = [...pending.entries()].filter(([, v]) => v.length > 1).map(([id]) => id)
  for (let i = 0; order.length < pending.size && i < 50; i++) for (const q of queues) if (q[i] && !order.includes(q[i])) order.push(q[i])
  for (const id of order.slice(0, NEW_POSTS_PER_RUN)) {
    if (overBudget()) break
    try {
      let raw = await getPost(c, id)
      // People often like a repost. The original is the post worth a comment, so read that instead.
      if (raw.is_repost && raw.repost_content?.id && !overBudget()) {
        const orig = raw.repost_content.id
        const k = known(orig)
        if (k) {
          pending.get(id)?.forEach((via) => touches.push({ socialId: k, via }))
          continue
        }
        raw = await getPost(c, orig)
      }
      const f = toFeed(raw, 'feed')
      if (f && Date.parse(f.date) >= cutoff) newPosts.push({ ...f, via: pending.get(id), countsAt: new Date().toISOString() })
      else {
        unusable.push(id)
        why[id] = reason(raw)
      }
    } catch (e) {
      // Unreadable (e.g. an id format the endpoint rejects): skip it rather than retrying every pass.
      unusable.push(id)
      why[id] = `error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`
      console.error('[circle] post', e instanceof Error ? e.message : e)
    }
  }

  // Refresh counts on the most promising fresh posts, so momentum stays current.
  const refreshed: FeedPost[] = []
  /** Attempted refreshes, worked or not, so one bad post can't hog the slot. */
  const refreshTried: string[] = []
  const gone: string[] = []
  const stale = [...(s0.circlePosts ?? [])]
    .filter((p) => now - Date.parse(p.date) < 36 * HOUR && (!p.countsAt || now - Date.parse(p.countsAt) > REFRESH_EVERY_MS))
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, REFRESHES_PER_RUN)
  for (const p of stale) {
    if (overBudget()) break
    refreshTried.push(p.socialId)
    try {
      const f = toFeed(await getPost(c, p.socialId), 'feed')
      if (f) refreshed.push(f)
      else gone.push(p.socialId) // comments turned off: no use to you any more
    } catch (e) {
      console.error('[circle] refresh', e instanceof Error ? e.message : e)
    }
  }

  await mutate((s) => {
    const at = new Date().toISOString()
    const byId = new Map((s.circlePosts ?? []).map((p) => [p.socialId, p]))
    const addVia = (p: FeedPost, v: Via) => {
      const list = p.via ?? []
      if (!list.some((x) => x.id === v.id && x.kind === v.kind)) p.via = [...list, v]
    }
    for (const n of newPosts) {
      const e = byId.get(n.socialId)
      if (e) n.via?.forEach((v) => addVia(e, v))
      else byId.set(n.socialId, n)
    }
    for (const t of touches) {
      const e = byId.get(t.socialId)
      if (e) addVia(e, t.via)
    }
    for (const id of refreshTried) {
      const e = byId.get(id)
      if (e) e.countsAt = at
    }
    for (const r of refreshed) {
      const e = byId.get(r.socialId)
      if (e) Object.assign(e, { reactions: r.reactions, comments: r.comments, countsAt: at })
    }
    gone.forEach((id) => byId.delete(id))
    // Someone removed while this run was going doesn't sneak back in.
    const excluded = new Set(s.circleExcluded ?? [])
    s.circlePosts = [...byId.values()]
      .map((p) => ({ ...p, via: p.via?.filter((v) => !excluded.has(v.id)) }))
      .filter((p) => !(p.authorId && excluded.has(p.authorId)) && (p.via?.length ?? 0) > 0)
      .filter((p) => Date.parse(p.date) >= Date.now() - CACHE_WINDOW_MS)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, CACHE_MAX)
    const until = new Date(Date.now() + CACHE_WINDOW_MS).toISOString()
    const sk = Object.fromEntries(Object.entries(s.circleSkip ?? {}).filter(([, t]) => Date.parse(t) > Date.now()))
    for (const id of unusable) sk[postKey(id)] = until
    s.circleSkip = Object.fromEntries(Object.entries(sk).slice(-3000))
    s.circleSkipWhy = Object.fromEntries([...Object.entries(s.circleSkipWhy ?? {}), ...Object.entries(why)].slice(-40))
    if (s.circle) {
      for (const p of s.circle.people) {
        if (checkedOk.includes(p.id)) p.failures = 0
        if (failed.includes(p.id)) p.failures = (p.failures ?? 0) + 1
      }
      // People whose reads keep failing leave until the next daily rebuild.
      s.circle.people = s.circle.people.filter((p) => (p.failures ?? 0) < MAX_FAILURES || p.why.includes('watchlist'))
    }
  })
  return { checked: checkedOk.length, added: newPosts.length, refreshed: refreshed.length }
}
