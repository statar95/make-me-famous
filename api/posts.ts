import { MAX_MEDIA, MEDIA_RE, type Post, deleteOrphanMedia, json, mutate, requireAuth } from './_lib.js'

/** PUT /api/posts  body: Post  -> upsert */
export async function PUT(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const post = (await req.json().catch(() => null)) as Post | null
  if (!post?.id || typeof post.text !== 'string') return json({ error: 'Expected a post with id and text' }, 400)
  // Only the server moves a post into publishing or posted, so a stale tab can't re-queue a sent post.
  if (!['draft', 'scheduled', 'failed'].includes(post.status)) return json({ error: 'Invalid status' }, 400)
  if (post.status !== 'failed') delete post.error
  if (post.media !== undefined) {
    if (!Array.isArray(post.media) || post.media.length > MAX_MEDIA || !post.media.every((m) => MEDIA_RE.test(m)))
      return json({ error: `media must be up to ${MAX_MEDIA} uploaded image paths` }, 400)
    post.media = [...new Set(post.media)]
  }
  if (post.firstComment !== undefined && (typeof post.firstComment !== 'string' || post.firstComment.length > 1250))
    return json({ error: 'firstComment must be text, up to 1,250 characters' }, 400)
  if (
    post.mentions !== undefined &&
    !(
      Array.isArray(post.mentions) &&
      post.mentions.length <= 20 &&
      post.mentions.every(
        (m) =>
          typeof m?.name === 'string' &&
          m.name.trim().length > 0 &&
          m.name.length <= 100 &&
          typeof m.profileId === 'string' &&
          /^(AC|AD)[A-Za-z0-9_-]+$|^\d+$/.test(m.profileId),
      )
    )
  )
    return json({ error: 'mentions must be up to 20 {name, profileId} entries' }, 400)
  // Comment status is the server's to set too.
  delete post.comment

  let locked = false
  let dropped: string[] = []
  await mutate((s) => {
    const i = s.posts.findIndex((p) => p.id === post.id)
    locked = i >= 0 && (s.posts[i].status === 'posted' || s.posts[i].status === 'publishing')
    dropped = []
    if (locked) return
    if (i >= 0) {
      dropped = (s.posts[i].media ?? []).filter((m) => !post.media?.includes(m))
      s.posts[i] = post
    } else s.posts.unshift(post)
  })
  if (locked) return json({ error: 'That post has already gone out or is going out now' }, 409)
  await deleteOrphanMedia(dropped)
  return json({ ok: true })
}

/** DELETE /api/posts?id=abc */
export async function DELETE(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return json({ error: 'Missing id' }, 400)
  let media: string[] = []
  await mutate((s) => {
    const gone = s.posts.find((p) => p.id === id && p.status !== 'publishing')
    media = gone?.media ?? []
    s.posts = s.posts.filter((p) => p.id !== id || p.status === 'publishing')
  })
  // Only images no other post still uses, e.g. a "Reuse as draft" copy.
  await deleteOrphanMedia(media)
  return json({ ok: true })
}
