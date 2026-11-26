import { useCallback, useEffect, useRef, useState } from 'react'

export type Platform = 'linkedin' | 'x'
export type Status = 'draft' | 'scheduled' | 'publishing' | 'failed' | 'posted'

export interface PublishResult {
  platform: Platform
  id: string
  at: string
  socialId?: string
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
  /** HH:MM in the schedule's time zone */
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
  impressions?: number
  hasMedia: boolean
  viaApp: boolean
}

export interface Analytics {
  fetchedAt?: string
  attemptedAt?: string
  error?: string
  posts: AnalyticsPost[]
}

export interface Post {
  id: string
  text: string
  /** Optional working title or angle. Never published. */
  title?: string
  /** Optional private notes, e.g. the source story. Never published. */
  notes?: string
  platforms: Platform[]
  status: Status
  scheduledAt: string | null
  postedAt: string | null
  createdAt: string
  updatedAt: string
  results?: PublishResult[]
  /** Why publishing failed. */
  error?: string
  /** Uploaded image paths (media/…), in order. */
  media?: string[]
  /** Posted as a comment straight after the post goes out. */
  firstComment?: string
  /** Set by the server once the post is live. */
  comment?: CommentState
  /** People to tag: each "@name" in the text becomes a LinkedIn mention. */
  mentions?: Mention[]
  /** Finished and waiting for a time: the Ready column. */
  ready?: boolean
}

export interface Mention {
  name: string
  profileId: string
  isCompany?: boolean
  headline?: string
  picture?: string
  url?: string
  /** Connection degree (1, 2, 3), search results only. */
  degree?: string
}

export interface RiffTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface RiffAnswer {
  reply: string
  revised_text: string | null
  revised_comment: string | null
}
export interface Suggestion {
  label: string
  why: string
  revised_text: string
}
/** Claude's own ideas for improving the draft, each as a full post you can apply. */
/** What Claude is helping with: a post, or a reply (with what it replies to). */
export interface RiffTarget {
  kind: 'post' | 'reply'
  context?: string
}
export async function riffSuggest(text: string, firstComment: string, target?: RiffTarget): Promise<Suggestion[]> {
  const data = await api('/api/riff', {
    method: 'POST',
    body: JSON.stringify({ text, firstComment, mode: 'suggest', ...target }),
  })
  return data.suggestions ?? []
}

/** Asks Claude about the draft. Nothing is saved: applying a revision is up to the editor. */
export async function riff(text: string, firstComment: string, turns: RiffTurn[], target?: RiffTarget): Promise<RiffAnswer> {
  return api('/api/riff', { method: 'POST', body: JSON.stringify({ text, firstComment, turns, ...target }) })
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
  replies: { author: string; text: string }[]
}
export interface CockpitPost {
  socialId: string
  url?: string
  date: string
  preview: string
  comments: CockpitComment[]
  error?: string
}
/** Comments on your last week of posts that you haven't replied to. */
export async function fetchComments(): Promise<CockpitPost[]> {
  return (await api('/api/comments')).posts ?? []
}
/** Replies on LinkedIn, under the comment. */
export async function sendReply(body: { socialId: string; commentId?: string; text: string; mentions?: Mention[] }) {
  return api('/api/comments', { method: 'POST', body: JSON.stringify(body) })
}
/** Claude drafts a reply in your voice. */
export async function draftReply(postText: string, c: CockpitComment): Promise<string> {
  const data = await api('/api/riff', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'reply',
      text: postText,
      comment: { author: c.author, headline: c.headline, text: c.text, replies: c.replies },
    }),
  })
  return data.reply ?? ''
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
  /** Who in your circle posted, liked or commented on it. */
  via?: { id: string; name: string; kind: 'posted' | 'liked' | 'commented' }[]
}
export interface EngageSettings {
  watchlist: { name: string; profileId: string; headline?: string; picture?: string; url?: string }[]
  topics: string[]
  minReactions: number
  network?: { connections: boolean; following: boolean }
  feedMinReactions?: number
  industries?: { id: string; title: string }[]
}
/** How comments landed, for one person, one topic or the whole watchlist. Mirrors api/_engagement.ts. */
export interface Score {
  comments: number
  measured: number
  avgLikes: number
  authorReplied: number
  authorLiked: number
  engagedBack: number
}
export interface EngageStats {
  total: number
  byPerson: Record<string, Score & { name: string }>
  byTopic: Record<string, Score>
  watchlist: Score
  feed: Score
}
export interface PersonSuggestion {
  profileId: string
  name: string
  headline?: string
  picture?: string
  url?: string
  why: 'engages-with-you' | 'topic-author'
  reason: string
  score: number
}
export interface CirclePerson {
  id: string
  name: string
  headline?: string
  picture?: string
  url?: string
  why: ('watchlist' | 'engager' | 'message' | 'poster')[]
}
export interface CircleInfo {
  builtAt: string | null
  size: number
  checkedToday: number
  cached: number
  minReactions: number
  people: CirclePerson[]
}
/** Your circle's feed (from the cache, instant), plus how it's going. */
export async function fetchEngage(): Promise<{
  settings: EngageSettings
  posts: FeedPost[]
  errors: string[]
  stats: EngageStats
  engagersAt: string | null
  circle: CircleInfo
}> {
  return api('/api/engage')
}
/** Live searches: topics and your sector, plus who to follow. Slower. */
export async function fetchMore(): Promise<{ posts: FeedPost[]; errors: string[]; suggestions: PersonSuggestion[] }> {
  return api('/api/engage?view=more')
}
/** LinkedIn industries matching q, for the sector picker. */
export async function searchIndustries(q: string, signal?: AbortSignal): Promise<{ id: string; title: string }[]> {
  const data = await api(`/api/engage?industry=${encodeURIComponent(q)}`, { signal })
  return data.results ?? []
}
/** Takes someone out of your circle for good. */
export async function excludeFromCircle(profileId: string) {
  return api('/api/engage', { method: 'POST', body: JSON.stringify({ exclude: profileId }) })
}
/** Never suggest this person again. */
export async function dismissSuggestion(profileId: string) {
  return api('/api/engage', { method: 'POST', body: JSON.stringify({ dismiss: profileId }) })
}
/** Comments tab: comment on someone's post, logged so the outcome gets tracked. */
export async function sendComment(p: FeedPost, text: string) {
  const meta = {
    author: p.author,
    authorId: p.authorId,
    url: p.url?.startsWith('https://') ? p.url : undefined,
    source: p.source,
    topic: p.topic?.slice(0, 80),
  }
  return api('/api/comments', { method: 'POST', body: JSON.stringify({ socialId: p.socialId, text, meta }) })
}
export async function saveEngage(settings: EngageSettings) {
  return api('/api/engage', { method: 'PUT', body: JSON.stringify(settings) })
}
/** Claude drafts a comment on someone else's post, in your voice. */
export async function draftComment(p: FeedPost): Promise<string> {
  const data = await api('/api/riff', {
    method: 'POST',
    body: JSON.stringify({ mode: 'comment', text: '', comment: { author: p.author, headline: p.headline, text: p.text } }),
  })
  return data.reply ?? ''
}

export type Reaction = 'like' | 'celebrate' | 'support' | 'love' | 'insightful' | 'funny'
/** Likes (or reacts to) a post, or a comment under it, on LinkedIn. */
export async function react(socialId: string, reaction: Reaction, commentId?: string) {
  return api('/api/react', { method: 'POST', body: JSON.stringify({ socialId, commentId, reaction }) })
}

/** Finds people and companies on LinkedIn to tag. */
export async function searchMentions(q: string, signal?: AbortSignal): Promise<Mention[]> {
  const data = await api(`/api/mentions?q=${encodeURIComponent(q)}`, { signal })
  return data.results ?? []
}

/** Same matching rule as the server (api/_publish.ts): whole name, not inside a URL or email. */
export function mentionRegex(name: string) {
  return new RegExp(`(?<![\\p{L}\\p{N}_./@])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u')
}

export interface Profile {
  name: string
  headline: string
  handle: string
  /** Profile photo URL, for the preview. */
  picture?: string
}

export type Phase = 'loading' | 'locked' | 'ready' | 'error'

const DEFAULT_PROFILE: Profile = { name: 'Your Name', headline: 'Your headline', handle: 'you' }
export const DEFAULT_SCHEDULE: Schedule = {
  timeZone: 'Europe/London',
  slots: [
    { weekday: 2, time: '08:30' },
    { weekday: 4, time: '08:30' },
  ],
}
export const MAX_MEDIA = 9

class Unauthorized extends Error {}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Request failed (${res.status})`)
  return res.json()
}

export const uid = () => Math.random().toString(36).slice(2, 10)

/** Server-backed store. Updates the screen optimistically, then saves to /api. */
export function useStore(onError: (msg: string) => void) {
  const [posts, setPosts] = useState<Post[]>([])
  const [profile, setProfileState] = useState<Profile>(DEFAULT_PROFILE)
  const [schedule, setScheduleState] = useState<Schedule>(DEFAULT_SCHEDULE)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const postsRef = useRef(posts)
  postsRef.current = posts

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof Unauthorized) setPhase('locked')
      else onError(e instanceof Error ? e.message : 'Something went wrong saving that')
    },
    [onError],
  )

  const refresh = useCallback(async () => {
    try {
      const s = await api('/api/state')
      setPosts(s.posts)
      setProfileState(s.profile)
      if (s.schedule) setScheduleState(s.schedule)
      if (s.analytics) setAnalytics(s.analytics)
      setPhase('ready')
    } catch (e) {
      if (e instanceof Unauthorized) setPhase('locked')
      else setPhase((p) => (p === 'ready' ? p : 'error'))
    }
  }, [])

  useEffect(() => {
    refresh()
    // Pick up drafts imported or edited elsewhere when you come back to the tab.
    const onFocus = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onFocus)
    return () => document.removeEventListener('visibilitychange', onFocus)
  }, [refresh])

  const login = async (password: string) => {
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) })
      await refresh()
      return true
    } catch {
      return false
    }
  }

  const logout = async () => {
    await api('/api/login', { method: 'DELETE' }).catch(() => {})
    setPosts([])
    setPhase('locked')
  }

  const save = (post: Post) => api('/api/posts', { method: 'PUT', body: JSON.stringify(post) }).catch(fail)

  const upsert = (post: Post) => {
    const next = { ...post, updatedAt: new Date().toISOString() }
    setPosts((ps) => (ps.some((p) => p.id === next.id) ? ps.map((p) => (p.id === next.id ? next : p)) : [next, ...ps]))
    return save(next)
  }

  const remove = (id: string) => {
    setPosts((ps) => ps.filter((p) => p.id !== id))
    return api(`/api/posts?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(fail)
  }

  const patch = (id: string, changes: Partial<Post>) => {
    const current = postsRef.current.find((p) => p.id === id)
    if (current) return upsert({ ...current, ...changes })
  }

  /** Saves the latest text, then publishes for real. Throws with the reason if it fails. */
  const publish = async (post: Post) => {
    const next: Post = { ...post, status: post.status === 'failed' ? 'draft' : post.status, updatedAt: new Date().toISOString() }
    setPosts((ps) => (ps.some((p) => p.id === next.id) ? ps.map((p) => (p.id === next.id ? next : p)) : [next, ...ps]))
    try {
      await api('/api/posts', { method: 'PUT', body: JSON.stringify(next) })
      await api('/api/publish', { method: 'POST', body: JSON.stringify({ id: next.id }) })
    } finally {
      await refresh()
    }
  }

  const setProfile = (p: Profile) => {
    setProfileState(p)
    return api('/api/profile', { method: 'PUT', body: JSON.stringify(p) }).catch(fail)
  }

  /** Puts a draft in the next free slot. Resolves to the time it landed on. */
  const queue = async (id: string): Promise<string> => {
    try {
      const r = await api('/api/queue', { method: 'POST', body: JSON.stringify({ id }) })
      return r.scheduledAt
    } finally {
      await refresh()
    }
  }

  const retryComment = async (id: string) => {
    try {
      await api('/api/comment', { method: 'POST', body: JSON.stringify({ id }) })
    } finally {
      await refresh()
    }
  }

  const setSchedule = async (next: Schedule) => {
    setScheduleState(next)
    try {
      const r = await api('/api/slots', { method: 'PUT', body: JSON.stringify(next) })
      setScheduleState(r.schedule)
    } catch (e) {
      fail(e)
      await refresh()
    }
  }

  const loadAnalytics = useCallback(async () => {
    try {
      setAnalytics(await api('/api/analytics'))
    } catch (e) {
      if (e instanceof Unauthorized) setPhase('locked')
      else onError(e instanceof Error ? e.message : 'Could not load analytics')
    }
  }, [onError])

  return {
    posts,
    profile,
    schedule,
    analytics,
    phase,
    login,
    logout,
    refresh,
    upsert,
    remove,
    patch,
    publish,
    setProfile,
    queue,
    retryComment,
    setSchedule,
    loadAnalytics,
  }
}

// ---- Images ----

export const mediaUrl = (path: string) => `/api/media?path=${encodeURIComponent(path)}`

const UPLOAD_LIMIT = 3_900_000
const MAX_EDGE = 6012

function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read that image"))), type, quality),
  )
}

/**
 * Resizes and re-encodes in the browser so each upload fits a function request (4.5 MB) and
 * LinkedIn's 6012px limit. Re-encoding also strips EXIF, location included.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Only JPEG, PNG or WebP')
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  const draw = () => {
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  }
  draw()
  // PNGs keep transparency if they fit. Everything else becomes JPEG.
  if (file.type === 'image/png') {
    const png = await encode(canvas, 'image/png')
    if (png.size <= UPLOAD_LIMIT) return png
  }
  for (let round = 0; round < 8; round++) {
    for (const q of [0.9, 0.8, 0.7]) {
      const jpg = await encode(canvas, 'image/jpeg', q)
      if (jpg.size <= UPLOAD_LIMIT) return jpg
    }
    scale *= 0.75
    draw()
  }
  throw new Error('That image is too big, even squashed')
}

export async function uploadImage(file: File): Promise<string> {
  const body = await prepareImage(file)
  const res = await fetch('/api/media', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': body.type },
    body,
  })
  if (res.status === 401) throw new Error('Signed out. Sign in again.')
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `Upload failed (${res.status})`)
  return data.pathname
}

// ---- Posting slots (mirrors api/_slots.ts) ----

export const QUEUE_LEAD_MS = 15 * 60_000
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function offsetAt(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** The instant a wall-clock time happens in a time zone. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, timeZone: string) {
  const guess = Date.UTC(y, m, d, hh, mm)
  const first = guess - offsetAt(guess, timeZone)
  return guess - offsetAt(first, timeZone)
}

function zonedDate(ms: number, timeZone: string) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
    .split('-')
    .map(Number)
  return { y, m: m - 1, d }
}

export function upcomingSlots(schedule: Schedule, from: number, days: number): number[] {
  const start = zonedDate(from, schedule.timeZone)
  const out: number[] = []
  for (let i = 0; i <= days; i++) {
    const day = new Date(Date.UTC(start.y, start.m, start.d + i))
    for (const s of schedule.slots) {
      if (s.weekday !== day.getUTCDay()) continue
      const [hh, mm] = s.time.split(':').map(Number)
      const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm, schedule.timeZone)
      if (at >= from) out.push(at)
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

export const slotTaken = (posts: Post[], at: number, except?: string) =>
  posts.some(
    (p) =>
      p.id !== except &&
      (p.status === 'scheduled' || p.status === 'publishing') &&
      p.scheduledAt &&
      Math.abs(Date.parse(p.scheduledAt) - at) < 60_000,
  )

/** For a calendar day (local date): that weekday's first slot, else 08:30, in the schedule's zone. */
export function dayDropTime(schedule: Schedule, day: Date) {
  const first = schedule.slots
    .filter((s) => s.weekday === day.getDay())
    .map((s) => s.time)
    .sort()[0]
  const [hh, mm] = (first ?? '08:30').split(':').map(Number)
  return zonedTime(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, schedule.timeZone)
}

// ---- Platform rules ----

export const LIMITS: Record<Platform, number> = { linkedin: 3000, x: 280 }
export const PLATFORM_LABEL: Record<Platform, string> = { linkedin: 'LinkedIn', x: 'X' }

const URL_RE = /(https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s]*)/gi

/** X weights every URL as 23 chars and most emoji/CJK as 2. Close enough to the real rule. */
export function xLength(text: string): number {
  let n = 0
  const stripped = text.replace(URL_RE, () => {
    n += 23
    return ''
  })
  for (const ch of stripped) n += (ch.codePointAt(0) ?? 0) > 0x2000 ? 2 : 1
  return n
}

export function countFor(platform: Platform, text: string) {
  return platform === 'x' ? xLength(text) : [...text].length
}

/** Split long text into an X thread, breaking on paragraphs, then sentences, then words. */
export function splitThread(text: string, limit = 280): string[] {
  const budget = limit - 6 // room for " 1/9"
  if (xLength(text) <= limit) return [text]
  const pieces = text
    .split(/\n{2,}/)
    .flatMap((para) => (xLength(para) <= budget ? [para] : para.split(/(?<=[.!?])\s+/)))
    .flatMap((s) => {
      if (xLength(s) <= budget) return [s]
      const out: string[] = []
      let cur = ''
      for (const w of s.split(' ')) {
        if (xLength(cur ? cur + ' ' + w : w) > budget) {
          if (cur) out.push(cur)
          cur = w
        } else cur = cur ? cur + ' ' + w : w
      }
      if (cur) out.push(cur)
      return out
    })
  const tweets: string[] = []
  let cur = ''
  for (const p of pieces) {
    const joined = cur ? cur + '\n\n' + p : p
    if (xLength(joined) > budget && cur) {
      tweets.push(cur)
      cur = p
    } else cur = joined
  }
  if (cur) tweets.push(cur)
  return tweets.map((t, i) => `${t} ${i + 1}/${tweets.length}`)
}

// ---- Date helpers ----

export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function dayLabel(d: Date) {
  const today = new Date()
  const tomorrow = new Date()
  tomorrow.setDate(today.getDate() + 1)
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, tomorrow)) return 'Tomorrow'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** Next occurrence of a weekday (0=Sun) at hh:mm, at least an hour from now. */
export function nextSlot(weekday: number | null, hh: number, mm = 0) {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setHours(hh, mm)
  if (weekday === null) d.setDate(d.getDate() + 1)
  else {
    let add = (weekday - d.getDay() + 7) % 7
    if (add === 0 && d.getTime() < Date.now() + 3600_000) add = 7
    d.setDate(d.getDate() + add)
  }
  return d
}
