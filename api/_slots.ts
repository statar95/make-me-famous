import type { Post, Schedule } from './_lib.js'

// Weekly posting slots. Mirrored in src/store.ts for the planner, so keep the two in step.

export const QUEUE_LEAD_MS = 15 * 60_000

/** Offset of a time zone from UTC at a given instant, in ms. */
function offsetAt(ms: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** The instant a wall-clock time happens in a time zone. */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, timeZone: string) {
  const guess = Date.UTC(y, m, d, hh, mm)
  const first = guess - offsetAt(guess, timeZone)
  return guess - offsetAt(first, timeZone)
}

function zonedDate(ms: number, timeZone: string) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
    .split('-')
    .map(Number)
  return { y, m: m - 1, d }
}

/** Every slot instant from `from` for `days` days, sorted. */
export function upcomingSlots(schedule: Schedule, from: number, days: number): number[] {
  const start = zonedDate(from, schedule.timeZone)
  const out: number[] = []
  for (let i = 0; i <= days; i++) {
    const day = new Date(Date.UTC(start.y, start.m, start.d + i))
    for (const s of schedule.slots) {
      if (s.weekday !== day.getUTCDay()) continue
      const [hh, mm] = s.time.split(':').map(Number)
      const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm, schedule.timeZone)
      if (at >= from) out.push(at)
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

const taken = (posts: Post[], at: number, except?: string) =>
  posts.some(
    (p) =>
      p.id !== except &&
      (p.status === 'scheduled' || p.status === 'publishing') &&
      p.scheduledAt &&
      Math.abs(Date.parse(p.scheduledAt) - at) < 60_000,
  )

/** The next slot at least 15 minutes away with nothing scheduled in it. */
export function nextFreeSlot(schedule: Schedule, posts: Post[], now: number, except?: string): number | null {
  return upcomingSlots(schedule, now + QUEUE_LEAD_MS, 7 * 26).find((at) => !taken(posts, at, except)) ?? null
}

export function validSchedule(v: unknown): Schedule | null {
  const s = v as Schedule
  if (!s || typeof s.timeZone !== 'string' || !Array.isArray(s.slots) || s.slots.length > 28) return null
  try {
    new Intl.DateTimeFormat('en', { timeZone: s.timeZone })
  } catch {
    return null
  }
  const ok = s.slots.every(
    (x) => Number.isInteger(x?.weekday) && x.weekday >= 0 && x.weekday <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.time),
  )
  if (!ok) return null
  const seen = new Set<string>()
  const slots = s.slots
    .map((x) => ({ weekday: x.weekday, time: x.time }))
    .filter((x) => !seen.has(`${x.weekday} ${x.time}`) && seen.add(`${x.weekday} ${x.time}`))
    .sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time))
  return { timeZone: s.timeZone, slots }
}
