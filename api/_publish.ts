import { MAX_MEDIA, MEDIA_TYPES, type Mention, type Post, mutate, readMedia } from './_lib.js'

// Real publishing, through Unipile. LinkedIn only: Unipile's create-post route doesn't document X.

export const config = () => {
  const dsn = process.env.UNIPILE_DSN
  const key = process.env.UNIPILE_API_KEY
  const account = process.env.UNIPILE_ACCOUNT_ID
  return dsn && key && account ? { dsn, key, account } : null
}

export type Config = NonNullable<ReturnType<typeof config>>

/** Calls Unipile and throws with its error title if the call fails. */
export async function unipile<T>(c: Config, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${c.dsn}${path}`, {
    ...init,
    headers: { 'X-API-KEY': c.key, accept: 'application/json', ...init.headers },
    signal: AbortSignal.timeout(30_000),
  })
  const data = (await res.json().catch(() => null)) as (T & { title?: string; detail?: string }) | null
  if (!res.ok) {
    const where = path.split('?')[0].replace(/\/users\/(?!me\b)[^/]+/, '/users/{id}')
    const why = [data?.title, data?.detail].filter(Boolean).join(' - ').slice(0, 300)
    throw new Error(`Unipile ${res.status} on ${where}${why ? `: ${why}` : ''}`)
  }
  return data as T
}

interface Image {
  bytes: Uint8Array
  name: string
  type: string
}

async function loadImages(paths: string[]): Promise<Image[]> {
  if (paths.length > MAX_MEDIA) throw new Error(`LinkedIn takes at most ${MAX_MEDIA} images`)
  return Promise.all(
    paths.map(async (p, i) => {
      const bytes = await readMedia(p)
      if (!bytes) throw new Error(`Image ${i + 1} is missing`)
      const ext = p.split('.').pop()!
      return { bytes, name: `image-${i + 1}.${ext}`, type: MEDIA_TYPES[ext] }
    }),
  )
}

/**
 * Turns "@Name" into Unipile's "{{i}}" placeholders and adds the matching mentions to the form.
 * Longest names first, so "@Jane Doe" wins over a separate "@Jane". A name that isn't in
 * the text is left out, so the indexes always line up with the placeholders.
 */
// Off until one real mention has been seen to tag correctly on LinkedIn. While off, posts go out
// with plain "@Name" text, so a wrong guess about Unipile's encoding can never publish "{{0}}".
export const MENTIONS_LIVE = process.env.MENTIONS_LIVE === '1'

export function applyMentions(text: string, mentions: Mention[] = [], form?: FormData) {
  if (!MENTIONS_LIVE && form) return { text, used: [] as Mention[] }
  // A literal {{n}} already in the text would be read as a mention, so break it up.
  let out = text.replace(/\{\{(\d+)\}\}/g, '{ {$1} }')
  const used: Mention[] = []
  const valid = mentions.filter((m) => m?.name?.trim() && m?.profileId?.trim())
  for (const m of [...valid].sort((a, b) => b.name.length - a.name.length)) {
    // "@Jan" must not match inside "@Jane".
    const tag = new RegExp(`(?<![\\p{L}\\p{N}_./@])@${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu')
    if (!tag.test(out)) continue
    tag.lastIndex = 0
    out = out.replace(tag, `{{${used.length}}}`)
    used.push(m)
  }
  if (form)
    used.forEach((m, i) => {
      form.append(`mentions[${i}][name]`, m.name)
      form.append(`mentions[${i}][profile_id]`, m.profileId)
      if (m.isCompany || /^\d+$/.test(m.profileId)) form.append(`mentions[${i}][is_company]`, 'true')
    })
  return { text: out, used }
}

async function sendToLinkedIn(c: Config, rawText: string, images: Image[], mentions?: Mention[]) {
  const form = new FormData()
  form.append('account_id', c.account)
  form.append('text', applyMentions(rawText, mentions, form).text)
  for (const img of images) form.append('attachments', new Blob([Buffer.from(img.bytes)], { type: img.type }), img.name)
  const data = await unipile<{ post_id?: string | null }>(c, '/api/v1/posts', { method: 'POST', body: form })
  return data?.post_id ?? 'unknown'
}

/**
 * The comment route wants the post's social_id (urn:li:activity:…), which the create response
 * doesn't include, so look it up. Falls back to the raw id if the lookup fails.
 */
async function socialIdFor(c: Config, postId: string) {
  if (postId.startsWith('urn:')) return postId
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const post = await unipile<{ social_id?: string }>(
        c,
        `/api/v1/posts/${encodeURIComponent(postId)}?account_id=${encodeURIComponent(c.account)}`,
      )
      if (post?.social_id) return post.social_id
    } catch (e) {
      console.error('[comment] post lookup failed', e instanceof Error ? e.message : e)
    }
    // Freshly created posts can take a moment to show up.
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1500))
  }
  return postId
}

export type PublishOutcome = { ok: true; post: Post } | { ok: false; status: number; error: string }

/**
 * Claims the post first, so it can only ever be sent once. A failed send is never retried
 * automatically, because a timeout can still mean it went out.
 */
export async function publishPost(id: string): Promise<PublishOutcome> {
  const c = config()
  if (!c) return { ok: false, status: 503, error: 'Unipile is not configured' }

  let refusal: { status: number; error: string } | null = null
  let claimed: Post | undefined
  await mutate((s) => {
    refusal = null
    claimed = undefined
    const post = s.posts.find((p) => p.id === id)
    if (!post) refusal = { status: 404, error: 'Post not found' }
    else if (post.status === 'posted') refusal = { status: 409, error: 'Already posted' }
    else if (post.status === 'publishing') refusal = { status: 409, error: 'Already being published' }
    else if (!post.text.trim()) refusal = { status: 400, error: 'Post is empty' }
    else if (!post.platforms.includes('linkedin')) {
      post.status = 'failed'
      post.error = "X isn't connected, so this post has nothing to publish to"
      post.updatedAt = new Date().toISOString()
      refusal = { status: 400, error: post.error }
    } else {
      post.status = 'publishing'
      post.error = undefined
      post.comment = undefined
      post.updatedAt = new Date().toISOString()
      claimed = { ...post }
    }
  })
  if (refusal) return { ok: false, ...(refusal as { status: number; error: string }) }
  const { text, media = [], firstComment, mentions } = claimed!

  const markFailed = (error: string) =>
    mutate((s) => {
      const post = s.posts.find((p) => p.id === id)
      if (!post) return
      post.status = 'failed'
      post.error = error
      post.updatedAt = new Date().toISOString()
    })

  // Nothing has gone out yet, so a missing image is a plain failure.
  let images: Image[]
  try {
    images = await loadImages(media)
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not load the images'
    await markFailed(`${error}. Nothing was sent.`)
    return { ok: false, status: 400, error }
  }

  let providerId: string
  try {
    providerId = await sendToLinkedIn(c, text, images, mentions)
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Publishing failed'
    await markFailed(`${error}. Check LinkedIn before trying again, in case it went out.`)
    return { ok: false, status: 502, error }
  }

  const wantsComment = !!firstComment?.trim()
  let posted: Post | undefined
  await mutate((s) => {
    const post = s.posts.find((p) => p.id === id)
    if (!post) return
    const at = new Date().toISOString()
    post.status = 'posted'
    post.postedAt = at
    post.updatedAt = at
    post.platforms = ['linkedin']
    post.results = [{ platform: 'linkedin', id: providerId, at }]
    post.comment = wantsComment ? { status: 'sending', at } : undefined
    posted = { ...post }
  })

  // The post is live from here on. Nothing below can mark it failed or send it again.
  if (wantsComment && posted) posted = (await deliverComment(c, posted)) ?? posted
  return { ok: true, post: posted! }
}

/**
 * "Retry comment". Claims the comment like publishPost claims a post, then sends only the comment.
 * Returns the refusal reason instead of sending if the comment isn't in a retryable state.
 */
export async function retryComment(
  id: string,
): Promise<{ ok: true; post: Post } | { ok: false; status: number; error: string }> {
  const c = config()
  if (!c) return { ok: false, status: 503, error: 'Unipile is not configured' }
  let refusal: { status: number; error: string } | null = null
  let target: Post | undefined
  await mutate((s) => {
    refusal = null
    target = undefined
    const post = s.posts.find((p) => p.id === id)
    if (!post) refusal = { status: 404, error: 'Post not found' }
    else if (post.status !== 'posted') refusal = { status: 409, error: "That post hasn't gone out" }
    else if (!post.firstComment?.trim()) refusal = { status: 400, error: 'No first comment to send' }
    else if (post.comment?.status === 'sending') refusal = { status: 409, error: 'Comment is already being sent' }
    else if (post.comment?.status === 'posted') refusal = { status: 409, error: 'Comment already posted' }
    else {
      post.comment = { status: 'sending', at: new Date().toISOString() }
      target = { ...post }
    }
  })
  if (refusal) return { ok: false, ...(refusal as { status: number; error: string }) }
  const after = await deliverComment(c, target!)
  return after?.comment?.status === 'posted'
    ? { ok: true, post: after }
    : { ok: false, status: 502, error: after?.comment?.error ?? 'Comment failed' }
}

/** Sends a claimed comment and records how it went. Never throws. */
async function deliverComment(c: Config, post: Post): Promise<Post | undefined> {
  let result: { status: 'posted'; id?: string; socialId: string } | { status: 'failed'; error: string }
  try {
    const postId = post.results?.[0]?.id
    if (!postId || postId === 'unknown')
      throw new Error("LinkedIn didn't return a post id, so there's nothing to comment on")
    const socialId = post.results?.[0]?.socialId ?? (await socialIdFor(c, postId))
    const form = new FormData()
    form.append('account_id', c.account)
    form.append('text', applyMentions(post.firstComment!.trim(), post.mentions, form).text)
    const data = await unipile<{ comment_id?: string }>(c, `/api/v1/posts/${encodeURIComponent(socialId)}/comments`, {
      method: 'POST',
      body: form,
    })
    result = { status: 'posted', id: data?.comment_id, socialId }
  } catch (e) {
    result = { status: 'failed', error: e instanceof Error ? e.message : 'Comment failed' }
  }

  let after: Post | undefined
  try {
    await mutate((s) => {
      const p = s.posts.find((x) => x.id === post.id)
      if (!p) return
      const at = new Date().toISOString()
      if (result.status === 'posted') {
        p.comment = { status: 'posted', id: result.id, at }
        if (p.results?.[0]) p.results[0].socialId = result.socialId
      } else p.comment = { status: 'failed', error: result.error, at }
      after = { ...p }
    })
  } catch (e) {
    console.error('[comment] could not record result', e instanceof Error ? e.message : e)
  }
  return after
}
