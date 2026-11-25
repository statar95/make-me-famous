import type { AnalyticsPost } from './store'

const TZ = 'Europe/London'

/**
 * What tends to work on LinkedIn for a UK B2B audience on a weekday, as a multiplier.
 * Used as the starting point, then pulled towards what has actually worked for you.
 */
const PRIOR_HOUR: Record<number, number> = {
  7: 0.8, 8: 1.0, 9: 1.05, 10: 1.0, 11: 0.95, 12: 1.0, 13: 0.95, 14: 0.85, 15: 0.8, 16: 0.8, 17: 0.85, 18: 0.75, 19: 0.6,
}
const PRIOR_DAY: Record<number, number> = { 1: 0.85, 2: 1.0, 3: 1.05, 4: 1.0, 5: 0.85, 6: 0.55, 0: 0.55 }
/** How many of your own posts it takes before your history outweighs the general pattern. */
const WEIGHT = 4

const parts = (d: Date) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', weekday: 'short', hour: '2-digit' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  )
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { day, hour: Number(p.hour) }
}

export interface Slot {
  at: Date
  score: number
  why: string
}

/**
 * The best 3 times to post on a given London day, from your own post history (reactions by hour
 * and weekday) blended with the usual LinkedIn pattern. Times land on odd minutes, never :00/:30.
 */
export function bestTimes(day: Date, history: AnalyticsPost[], now = new Date()): Slot[] {
  // Log reactions so one viral post doesn't decide everything.
  const score = (p: AnalyticsPost) => Math.log1p(p.reactions + 2 * p.comments)
  const all = history.map((p) => ({ ...parts(new Date(p.date)), s: score(p) }))
  const mean = all.length ? all.reduce((a, b) => a + b.s, 0) / all.length : 1
  const shrunk = (xs: number[], prior: number) => (xs.reduce((a, b) => a + b, 0) + WEIGHT * prior * mean) / (xs.length + WEIGHT)

  const wd = day.getDay()
  const dayXs = all.filter((x) => x.day === wd).map((x) => x.s)
  const dayFactor = shrunk(dayXs, PRIOR_DAY[wd]) / mean

  // `day` is a date you picked on the calendar: take its date as shown to you.
  const y = day.getFullYear()
  const m = day.getMonth() + 1
  const d = day.getDate()

  const slots: Slot[] = []
  for (let h = 7; h <= 19; h++) {
    // Your posts within an hour either side count, nearest most.
    const near = all.filter((x) => Math.abs(x.hour - h) <= 1)
    const exact = all.filter((x) => x.hour === h)
    const xs = [...exact.map((x) => x.s), ...near.filter((x) => x.hour !== h).map((x) => x.s * 0.9)]
    const hourScore = shrunk(xs, PRIOR_HOUR[h]) / mean
    // An odd minute that's stable for a given day and hour.
    const minute = [7, 12, 18, 23, 34, 41, 47, 52][(h * 7 + d) % 8]
    const at = londonTime(y, m, d, h, minute)
    if (at.getTime() < now.getTime() + 20 * 60_000) continue
    const n = exact.length
    const avg = n ? Math.round(history.filter((p) => parts(new Date(p.date)).hour === h).reduce((a, p) => a + p.reactions, 0) / n) : 0
    slots.push({
      at,
      score: hourScore * dayFactor,
      why: n
        ? `Your ${n} post${n > 1 ? 's' : ''} around ${String(h).padStart(2, '0')}:00 averaged ${avg} reactions`
        : 'A strong time on LinkedIn generally; you haven’t posted then yet',
    })
  }
  // Top 3, at least two hours apart, so you get genuinely different options.
  const picked: Slot[] = []
  for (const s of [...slots].sort((a, b) => b.score - a.score)) {
    if (picked.every((p) => Math.abs(p.at.getTime() - s.at.getTime()) >= 2 * 3600_000)) picked.push(s)
    if (picked.length === 3) break
  }
  return picked.sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** A London wall-clock time as a Date. */
function londonTime(y: number, m: number, d: number, hh: number, mm: number) {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm))
  const asLondon = new Date(guess.toLocaleString('en-US', { timeZone: TZ }))
  const asUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(guess.getTime() - (asLondon.getTime() - asUtc.getTime()))
}

/** The single best time that day (the ★ one), or null if the day's good times have passed. */
export function bestTime(day: Date, history: AnalyticsPost[], now = new Date()): Date | null {
  const slots = bestTimes(day, history, now)
  return slots.length ? slots.reduce((a, b) => (b.score > a.score ? b : a)).at : null
}
