import { json, requireAuth } from './_lib.js'
import { config, unipile } from './_publish.js'

interface Hit {
  type?: string
  id?: string
  name?: string
  headline?: string
  summary?: string | null
  industry?: string | null
  public_profile_url?: string
  profile_url?: string
  profile_picture_url?: string | null
  logo?: string | null
  network_distance?: string
}

async function search(c: NonNullable<ReturnType<typeof config>>, category: 'people' | 'companies', q: string) {
  const res = await unipile<{ items?: Hit[] }>(
    c,
    `/api/v1/linkedin/search?account_id=${encodeURIComponent(c.account)}&limit=5`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api: 'classic', category, keywords: q }),
    },
  )
  return (res.items ?? [])
    .filter((h) => h.id && h.name && h.name !== 'LinkedIn Member')
    .map((h) => ({
      name: h.name!,
      profileId: h.id!,
      isCompany: category === 'companies' || undefined,
      headline: (category === 'companies' ? h.industry : h.headline) ?? undefined,
      picture: (category === 'companies' ? h.logo : h.profile_picture_url) ?? undefined,
      url: h.public_profile_url ?? h.profile_url,
      degree: h.network_distance?.replace('DISTANCE_', ''),
    }))
}

/** GET /api/mentions?q=nico  -> people and companies on LinkedIn to tag. */
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const c = config()
  if (!c) return json({ error: 'Unipile is not configured' }, 503)
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2 || q.length > 80) return json({ results: [] })
  const [people, companies] = await Promise.allSettled([search(c, 'people', q), search(c, 'companies', q)])
  if (people.status === 'rejected' && companies.status === 'rejected')
    return json({ error: 'LinkedIn search failed. Try again in a moment.' }, 502)
  const ok = <T,>(r: PromiseSettledResult<T[]>) => (r.status === 'fulfilled' ? r.value : [])
  // People first (you usually tag people), then companies.
  return json({ results: [...ok(people).slice(0, 5), ...ok(companies).slice(0, 4)] })
}
