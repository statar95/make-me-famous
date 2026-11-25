import { json, mutate, requireAuth } from './_lib.js'
import { validSchedule } from './_slots.js'

/** PUT /api/slots  body: { timeZone, slots: [{ weekday, time }] } */
export async function PUT(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  const schedule = validSchedule(await req.json().catch(() => null))
  if (!schedule) return json({ error: 'Expected { timeZone, slots: [{ weekday: 0-6, time: "HH:MM" }] }' }, 400)
  await mutate((s) => {
    s.schedule = schedule
  })
  return json({ ok: true, schedule })
}
