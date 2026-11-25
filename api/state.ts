import { json, readState, requireAuth } from './_lib.js'

export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  return json(await readState())
}
