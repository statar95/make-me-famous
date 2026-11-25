import { MEDIA_RE, MEDIA_TYPES, json, readMedia, requireAuth, uid, writeMedia } from './_lib.js'

// Functions take bodies up to 4.5 MB. The browser resizes to under ~4 MB before sending.
const MAX_BYTES = 4_400_000

function sniff(b: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP')
    return 'webp'
  return null
}

/** POST /api/media  body: one image (JPEG, PNG or WebP)  -> { pathname } */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (!bytes.length) return json({ error: 'Send one image as the request body' }, 400)
  if (bytes.length > MAX_BYTES) return json({ error: 'Image is too big. Keep it under 4 MB.' }, 413)
  const ext = sniff(bytes)
  if (!ext) return json({ error: 'Only JPEG, PNG and WebP images' }, 415)
  const pathname = `media/${uid()}${uid()}.${ext}`
  await writeMedia(pathname, bytes)
  return json({ pathname })
}

/** GET /api/media?path=media/abc.jpg  -> the image, for previews. Never public. */
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const path = new URL(req.url).searchParams.get('path') ?? ''
  if (!MEDIA_RE.test(path)) return json({ error: 'Bad path' }, 400)
  const bytes = await readMedia(path)
  if (!bytes) return json({ error: 'Not found' }, 404)
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': MEDIA_TYPES[path.split('.').pop()!],
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  })
}
