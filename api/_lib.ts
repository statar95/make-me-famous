import { createHash, timingSafeEqual } from 'node:crypto'
import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob'
import type { FeedPost } from './_circle.js'

// Shapes mirror src/store.ts. Kept separate so the API has no client imports.
export type Platform = 'linkedin' | 'x'
export interface Post {
  id: string
  text: string
  title?: string
  notes?: string
  platforms: Platform[]
  status: 'draft' | 'scheduled' | 'publishing' | 'failed' | 'posted'
  /** Why publishing failed. Shown in the queue. */
  error?: string
  scheduledAt: string | null
  postedAt: string | null
  createdAt: string
  updatedAt: string
  results?: { platform: Platform; id: string; at: string; socialId?: string }[]
  /** Blob pathnames under media/, in display order. Max 9. */
  media?: string[]
  /** Posted as a comment once the post is live. */
  firstComment?: string
  /** Server-set. How the first comment went. */
  comment?: CommentState
  /**
   * People or companies to tag. Each "@name" in the text or first comment becomes a real
   * LinkedIn mention when it goes out. A name that isn't in the text is simply not tagged.
   */
  mentions?: Mention[]
  /** Finished and waiting for a time: the Ready column. */
  ready?: boolean
}
export interface Mention {
  /** Exactly as written after the @ in the text, e.g. "Jane Doe". */
  name: string
  /** LinkedIn provider id: ACo…/ADo… for people, digits for companies. */
  profileId: string
  isCompany?: boolean
  /** Display only, so you can check it's the right person: headline, photo, profile link. */
  headline?: string
  picture?: string
  url?: string
}
export interface CommentState {
  status: 'sending' | 'posted' | 'failed'
  error?: string
  id?: string
  at: string
}
export interface Slot {
  /** 0 = Sunday */
  weekday: number
  /** HH:MM, in the schedule's time zone */
  time: string
}
export interface Schedule {
  timeZone: string
  slots: Slot[]
}
export interface AnalyticsPost {
  id: string
  socialId?: string
  url?: string
  date: string
  preview: string
  reactions: number
  comments: number
  reposts: number
  /** Unknown (not 0) when LinkedIn didn't say. */
  impressions?: number
  hasMedia: boolean
  viaApp: boolean
}
export interface Analytics {
  fetchedAt?: string
  attemptedAt?: string
  error?: string
  providerId?: string
  /** Set once impressions have been read. A snapshot without it is refreshed straight away. */
  withImpressions?: boolean
  posts: AnalyticsPost[]
}
export interface Profile {
  name: string
  headline: string
  handle: string
  /** Profile photo URL, for the preview. */
  picture?: string
}
export interface State {
  posts: Post[]
  profile: Profile
  schedule: Schedule
  analytics?: Analytics
  /** Comment id (or "post:<socialId>" for a comment on a post) -> when we replied. Guards against doubles. */
  replied?: Record<string, string>
  /** What the Comments tab looks at: people to follow and topics to search. */
  engage?: EngageSettings
  /** Comments you made on other people's posts from the Comments tab, and how each one landed. Newest last. */
  commentLog?: LoggedComment[]
  /** When the cron last went through commentLog. */
  outcomesAt?: string
  /** Who reacts to and comments on your own posts. Refreshed daily by the cron. */
  engagers?: Engagers
  /** Suggested people you said no to. Never suggested again. */
  engageDismissed?: string[]
  /** The ~150 people whose activity builds your feed. Rebuilt daily by the cron. */
  circle?: Circle
  /** People you took out of your circle. Never added back. */
  circleExcluded?: string[]
  /** When the cron last checked circle activity. */
  circleRunAt?: string
  /** Posts your circle posted, liked or commented on in the last 72 hours. */
  circlePosts?: FeedPost[]
  /** Post ids already read that turned out unusable (old, repost, comments off, unreadable): key -> until when to skip. */
  circleSkip?: Record<string, string>
  /** Why the most recent skipped posts were skipped (diagnostics, last 40). */
  circleSkipWhy?: Record<string, string>
  /** Bumped when the skip rules change, so posts skipped under the old rules get another try. */
  circleSkipV?: number
}
export interface CirclePerson {
  id: string
  name: string
  headline?: string
  picture?: string
  url?: string
  /** Why they're in your circle. */
  why: ('watchlist' | 'engager' | 'message' | 'poster')[]
  /** When their activity was last attempted. */
  checkedAt?: string
  /** Checks in a row where every read failed. Three and they leave the circle until the next rebuild. */
  failures?: number
}
export interface Circle {
  builtAt?: string
  attemptedAt?: string
  error?: string
  people: CirclePerson[]
}
export interface LoggedComment {
  /** The post you commented on. One comment per post, so this is the key. */
  socialId: string
  commentId?: string
  url?: string
  author: string
  authorId?: string
  source: 'watchlist' | 'topic' | 'feed' | 'sector'
  topic?: string
  at: string
  outcome?: CommentOutcome
}
export interface CommentOutcome {
  checkedAt: string
  /** Couldn't find your comment on the post any more (deleted, or the post went). */
  missing?: boolean
  /** Checks in a row that couldn't find it. Two makes it missing. */
  misses?: number
  likes: number
  replies: number
  /** The post's author replied under your comment. */
  authorReplied: boolean
  /** The post's author reacted to your comment. */
  authorLiked: boolean
}
export interface Engager {
  id: string
  name: string
  headline?: string
  picture?: string
  url?: string
  comments: number
  reactions: number
  /** Dates of your posts they engaged with, newest first. */
  on: string[]
}
export interface Engagers {
  fetchedAt?: string
  attemptedAt?: string
  error?: string
  /** How many of your posts were read. */
  posts: number
  people: Engager[]
}
export interface EngageSettings {
  watchlist: { name: string; profileId: string; headline?: string; picture?: string; url?: string }[]
  topics: string[]
  /** Topic posts need at least this many reactions to show up. */
  minReactions: number
  /** Your LinkedIn feed, rebuilt: the last day's posts by your connections and people you follow. */
  network?: { connections: boolean; following: boolean }
  /** Feed posts need at least this many reactions. Default 30. */
  feedMinReactions?: number
  /** "Popular in your sector": LinkedIn industry ids to search, no keywords. */
  industries?: { id: string; title: string }[]
}

const PATH = 'state.json'

export const defaultSchedule = (): Schedule => ({
  timeZone: 'Europe/London',
  slots: [
    { weekday: 2, time: '08:30' },
    { weekday: 4, time: '08:30' },
  ],
})

const seed = (): State => ({
  profile: { name: 'Your Name', headline: 'Your headline', handle: 'you' },
  posts: [],
  schedule: defaultSchedule(),
})

// Older saved state predates slots.
const normalize = (s: State): State => ({ ...s, schedule: s.schedule ?? defaultSchedule() })

// ---- Storage: one private JSON blob. Single user, so read-modify-write is fine. ----

// Local dev always keeps state in memory, so it can't touch real drafts. Never on Vercel.
let memory: State | null = null
const inMemory = () => !process.env.VERCEL

// get() returns a weak ETag for compressed responses, which would never match on write.
async function readTagged(): Promise<{ state: State; etag?: string }> {
  if (inMemory()) return { state: normalize(structuredClone((memory ??= seed()))) }
  const res = await get(PATH, { access: 'private', useCache: false })
  if (!res) return { state: seed() }
  if (res.statusCode !== 200) throw new Error(`Could not read saved state (${res.statusCode})`)
  return { state: normalize((await new Response(res.stream).json()) as State), etag: res.blob.etag.replace(/^W\//, '') }
}

export async function readState(): Promise<State> {
  return (await readTagged()).state
}

async function writeState(state: State, etag?: string) {
  if (inMemory()) {
    memory = state
    return
  }
  await put(PATH, JSON.stringify(state), {
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
    ...(etag ? { ifMatch: etag } : {}),
  })
}

/** Read-modify-write. Retries if something else wrote first, so a publish claim can't be overwritten. */
export async function mutate(fn: (s: State) => State | void): Promise<State> {
  for (let attempt = 0; ; attempt++) {
    const { state, etag } = await readTagged()
    const next = fn(state) ?? state
    try {
      await writeState(next, etag)
      return next
    } catch (e) {
      console.error('[mutate] write failed', attempt, e instanceof Error ? `${e.name}: ${e.message}` : e)
      const conflict =
        e instanceof BlobPreconditionFailedError || (e instanceof Error && e.message.includes('conflicting operation'))
      if (!conflict || attempt >= 7) throw e
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 300 * (attempt + 1)))
    }
  }
}

// ---- Media: private blobs under media/. Served only through /api/media. ----

export const MEDIA_RE = /^media\/[a-z0-9]{8,32}\.(jpg|png|webp)$/
export const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
export const MAX_MEDIA = 9

const memoryMedia = new Map<string, Uint8Array>()

export async function writeMedia(pathname: string, bytes: Uint8Array) {
  if (inMemory()) return void memoryMedia.set(pathname, bytes)
  await put(pathname, Buffer.from(bytes), {
    access: 'private',
    addRandomSuffix: false,
    contentType: MEDIA_TYPES[pathname.split('.').pop()!],
  })
}

export async function readMedia(pathname: string): Promise<Uint8Array | null> {
  if (!MEDIA_RE.test(pathname)) return null
  if (inMemory()) return memoryMedia.get(pathname) ?? null
  const res = await get(pathname, { access: 'private' })
  if (!res || res.statusCode !== 200) return null
  return new Uint8Array(await new Response(res.stream).arrayBuffer())
}

/** Deletes media that no post references any more. Posts being published still reference theirs. */
export async function deleteOrphanMedia(candidates: string[]) {
  if (!candidates.length) return
  const state = await readState()
  const used = new Set(state.posts.flatMap((p) => p.media ?? []))
  const orphans = [...new Set(candidates)].filter((m) => MEDIA_RE.test(m) && !used.has(m))
  if (!orphans.length) return
  try {
    if (inMemory()) orphans.forEach((m) => memoryMedia.delete(m))
    else await del(orphans)
  } catch (e) {
    console.error('[media] delete failed', e instanceof Error ? e.message : e)
  }
}

// ---- Auth: one password from APP_PASSWORD. Fails closed if it isn't set. ----

export const COOKIE = 'mplm_session'

const sha = (v: string) => createHash('sha256').update(v).digest('hex')
export const sessionToken = (password: string) => sha(`mplm-session:${password}`)

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function checkPassword(candidate: string) {
  const pw = process.env.APP_PASSWORD
  return !!pw && safeEqual(sha(candidate), sha(pw))
}

/** Returns a Response to send back if the request is NOT authorized, else null. */
export function requireAuth(req: Request): Response | null {
  const pw = process.env.APP_PASSWORD
  if (!pw) return json({ error: 'APP_PASSWORD is not configured' }, 503)
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer && checkPassword(bearer)) return null
  const cookie = req.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  if (cookie && safeEqual(cookie, sessionToken(pw))) return null
  return json({ error: 'Not signed in' }, 401)
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

export const uid = () => Math.random().toString(36).slice(2, 10)
