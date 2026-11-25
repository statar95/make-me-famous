import { COOKIE, checkPassword, json, sessionToken } from './_lib.js'

const cookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

export async function POST(req: Request) {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string }
  if (!process.env.APP_PASSWORD) return json({ error: 'APP_PASSWORD is not configured' }, 503)
  if (!password || !checkPassword(password)) return json({ error: 'Wrong password' }, 401)
  return json({ ok: true }, 200, { 'set-cookie': cookie(sessionToken(process.env.APP_PASSWORD), 60 * 60 * 24 * 90) })
}

export function DELETE() {
  return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) })
}
