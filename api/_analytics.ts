import { type Analytics, type AnalyticsPost, type Post, mutate, readState } from './_lib.js'
import { config, unipile } from './_publish.js'

export const FRESH_MS = 6 * 3600_000
// After a failed or in-flight attempt, wait this long before trying again.
const BACKOFF_MS = 10 * 60_000

interface LinkedInPost {
  id: string
  social_id?: string
  share_url?: string
  text?: string
  parsed_datetime?: string
  date?: string
  reaction_counter?: number
  comment_counter?: number
  repost_counter?: number
  impressions_counter?: number
  analytics?: { impressions?: number }
  is_repost?: boolean
  attachments?: unknown[]
}

const ours = (item: LinkedInPost, posts: Post[]) =>
  posts.some((p) =>
    p.results?.some(
      (r) =>
        r.id === item.id ||
        (r.socialId && r.socialId === item.social_id) ||
        (!!item.social_id && item.social_id.endsWith(`:${r.id}`)),
    ),
  )

/**
 * Refreshes the LinkedIn snapshot if it's older than 6 hours. Returns the stored snapshot either way.
 * Never throws: errors are saved on the snapshot.
 */
export async function refreshAnalytics(): Promise<Analytics> {
  const c = config()
  const now = Date.now()
  const due = (a?: Analytics) =>
    !(a?.withImpressions && a?.fetchedAt && now - Date.parse(a.fetchedAt) < FRESH_MS) &&
    !(a?.attemptedAt && now - Date.parse(a.attemptedAt) < BACKOFF_MS)
  const current = (await readState()).analytics
  if (!c) return { ...(current ?? { posts: [] }), error: 'Unipile is not configured' }
  if (!due(current)) return current ?? { posts: [] }

  // Claim the attempt, so two tabs (or a tab and the cron) don't both fetch.
  let go = false
  const s0 = await mutate((s) => {
    go = due(s.analytics)
    if (go) s.analytics = { ...(s.analytics ?? { posts: [] }), attemptedAt: new Date(now).toISOString() }
  })
  if (!go) return s0.analytics ?? { posts: [] }

  try {
    const acct = encodeURIComponent(c.account)
    // The posts route wants the LinkedIn provider id (ACo…), not the Unipile account id.
    const providerId =
      s0.analytics?.providerId ??
      (await unipile<{ provider_id: string }>(c, `/api/v1/users/me?account_id=${acct}`)).provider_id
    if (!providerId) throw new Error('Unipile did not return your LinkedIn id')
    const items: LinkedInPost[] = []
    let cursor: string | null = null
    for (let page = 0; page < 3; page++) {
      const q: string = `account_id=${acct}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      let res: { items: LinkedInPost[]; cursor: string | null }
      try {
        res = await unipile(c, `/api/v1/users/${encodeURIComponent(providerId)}/posts?${q}`)
      } catch (e) {
        // Unipile can hand back a cursor it then rejects (pagination_token: null). Keep the pages we have.
        if (page === 0) throw e
        console.error('[analytics] stopped paging', e instanceof Error ? e.message : e)
        break
      }
      items.push(...(res.items ?? []))
      cursor = res.cursor
      if (!cursor) break
    }
    const { posts: appPosts } = await readState()
    const posts: AnalyticsPost[] = items
      .filter((i) => !i.is_repost)
      .map((i) => ({
        id: i.id,
        socialId: i.social_id,
        url: i.share_url,
        date: i.parsed_datetime ?? i.date ?? '',
        preview: (i.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140),
        reactions: i.reaction_counter ?? 0,
        comments: i.comment_counter ?? 0,
        reposts: i.repost_counter ?? 0,
        impressions: i.impressions_counter || undefined,
        hasMedia: (i.attachments?.length ?? 0) > 0,
        viaApp: ours(i, appPosts),
      }))
    // The list often leaves impressions out. Your own post, read singly, has them under analytics.
    // Only the 20 newest, a few at a time: older numbers barely move and are kept from last time.
    const previous = new Map((s0.analytics?.posts ?? []).map((p) => [p.id, p.impressions]))
    const missing = posts.filter((p) => p.impressions === undefined)
    for (const p of missing) if (previous.get(p.id) !== undefined) p.impressions = previous.get(p.id)
    const toRead = [...posts]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20)
      .filter((p) => !p.impressions || Date.now() - Date.parse(p.date) < 14 * 86_400_000)
    // Hard budget: this runs inside the cron, which also publishes.
    const stopAt = Date.now() + 25_000
    for (let i = 0; i < toRead.length && Date.now() < stopAt; i += 3)
      await Promise.all(
        toRead.slice(i, i + 3).map(async (p) => {
          try {
            const one = await Promise.race([
              unipile<LinkedInPost>(c, `/api/v1/posts/${encodeURIComponent(p.socialId ?? p.id)}?account_id=${acct}`),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 10_000)),
            ])
            const n = one.analytics?.impressions ?? one.impressions_counter
            if (n) p.impressions = n
          } catch (e) {
            console.error('[analytics] impressions', e instanceof Error ? e.message : e)
          }
        }),
      )
    const done = await mutate((s) => {
      s.analytics = { providerId, posts, fetchedAt: new Date().toISOString(), attemptedAt: s.analytics?.attemptedAt, withImpressions: true }
    })
    return done.analytics!
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not fetch posts'
    const failed = await mutate((s) => {
      s.analytics = { ...(s.analytics ?? { posts: [] }), error }
    })
    return failed.analytics!
  }
}
