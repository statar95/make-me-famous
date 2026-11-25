import { type Platform, type Post, json, mutate, requireAuth, uid } from './_lib.js'

interface DraftIn {
  text?: unknown
  platforms?: unknown
  title?: unknown
  notes?: unknown
}

const PLATFORMS: Platform[] = ['linkedin', 'x']
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/**
 * POST /api/import
 * Body: [{ text, platforms?, title?, notes? }, ...] or { drafts: [...] }
 * Every item becomes a draft. Exact-duplicate text (already in the app) is skipped,
 * so re-running the same batch is safe.
 */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as DraftIn[] | { drafts?: DraftIn[] } | null
  const items = Array.isArray(body) ? body : body?.drafts
  if (!Array.isArray(items)) return json({ error: 'Send an array of drafts, or { "drafts": [...] }' }, 400)

  const errors: { index: number; error: string }[] = []
  const valid: Omit<Post, 'id' | 'createdAt' | 'updatedAt'>[] = []
  items.forEach((d, index) => {
    const text = typeof d?.text === 'string' ? d.text.trim() : ''
    if (!text) return errors.push({ index, error: 'text is required' })
    let platforms: Platform[] = ['linkedin']
    if (d.platforms !== undefined) {
      const list = Array.isArray(d.platforms) ? d.platforms : [d.platforms]
      platforms = [...new Set(list.map((p) => String(p).toLowerCase()).map((p) => (p === 'twitter' ? 'x' : p)))] as Platform[]
      const bad = platforms.filter((p) => !PLATFORMS.includes(p))
      if (bad.length || !platforms.length) return errors.push({ index, error: `platforms must be "linkedin" and/or "x"` })
    }
    valid.push({ text, platforms, title: str(d.title), notes: str(d.notes), status: 'draft', scheduledAt: null, postedAt: null })
  })

  const imported: { index: number; id: string }[] = []
  const skipped: { index: number; reason: string }[] = []
  await mutate((s) => {
    const seen = new Set(s.posts.map((p) => p.text.trim()))
    const now = Date.now()
    valid.forEach((d, i) => {
      const index = items.findIndex((x) => typeof x?.text === 'string' && x.text.trim() === d.text)
      if (seen.has(d.text)) return skipped.push({ index, reason: 'duplicate text' })
      seen.add(d.text)
      // Stagger timestamps so the batch keeps its order in the drafts list (newest first = first item).
      const at = new Date(now - i).toISOString()
      const post: Post = { ...d, id: uid(), createdAt: at, updatedAt: at }
      s.posts.push(post)
      imported.push({ index, id: post.id })
    })
  })
  return json({ imported: imported.length, skipped, errors, ids: imported }, errors.length && !imported.length ? 400 : 200)
}
