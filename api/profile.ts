import { type Profile, json, mutate, requireAuth } from './_lib.js'

export async function PUT(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const profile = (await req.json()) as Profile
  await mutate((s) => {
    s.profile = { ...s.profile, ...profile }
  })
  return json({ ok: true })
}
