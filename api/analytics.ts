import { json, requireAuth } from './_lib.js'
import { refreshAnalytics } from './_analytics.js'

/** GET /api/analytics  -> your LinkedIn posts with engagement. Refetches at most every 6 hours. */
export async function GET(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  return json(await refreshAnalytics())
}
