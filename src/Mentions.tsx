import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react'
import { type Mention, mentionRegex, searchMentions } from './store'

/** "@Some Name" typed just before the caret: up to four words, so full names and firms work. */
const TYPING = /(?:^|[\s(])@([\p{L}\p{N}][\p{L}\p{N}'&.-]*(?: [\p{L}\p{N}'&.-]+){0,3})$/u
/** Capitalised @names anywhere in the text, for the "not tagged yet" check. */
const AT_NAMES = /(?<![\p{L}\p{N}_./@])@([\p{Lu}\p{N}][\p{L}\p{N}'&-]*(?: [\p{Lu}\p{N}][\p{L}\p{N}'&-]*){0,2})/gu

interface Query {
  q: string
  /** Where "@…" starts and ends in the text, so picking a result can replace it. */
  start: number
  end: number
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

function Avatar({ m }: { m: Mention }) {
  const [broken, setBroken] = useState(false)
  return m.picture && !broken ? (
    <img className={`mt-avatar ${m.isCompany ? 'co' : ''}`} src={m.picture} alt="" onError={() => setBroken(true)} />
  ) : (
    <span className={`mt-avatar mt-initials ${m.isCompany ? 'co' : ''}`}>{initials(m.name)}</span>
  )
}

/**
 * Type "@" and a name in the post: LinkedIn people and companies pop up to pick from, and the
 * tags list underneath shows exactly who each @name will tag when the post goes out.
 */
export function useMentions(props: {
  text: string
  setText: (t: string) => void
  textarea: RefObject<HTMLTextAreaElement | null>
  mentions: Mention[]
  setMentions: (m: Mention[]) => void
  comment?: string
}) {
  const { text, setText, textarea, mentions, setMentions } = props
  const [query, setQuery] = useState<Query | null>(null)
  const [results, setResults] = useState<Mention[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [active, setActive] = useState(0)
  const [searched, setSearched] = useState('')
  // Tags saved without a photo (e.g. added by Claude): look each one up once and fill in the
  // photo, headline and profile link, matched on the exact LinkedIn id so it can't swap people.
  const tried = useRef(new Set<string>())
  const latest = useRef(mentions)
  latest.current = mentions
  useEffect(() => {
    const missing = mentions.filter((m) => !m.picture && !tried.current.has(m.profileId))
    if (!missing.length) return
    missing.forEach((m) => tried.current.add(m.profileId))
    ;(async () => {
      const found = await Promise.all(
        missing.map((m) =>
          searchMentions(m.name)
            .then((rs) => rs.find((r) => r.profileId === m.profileId))
            .catch(() => undefined),
        ),
      )
      const byId = new Map(found.filter((f): f is Mention => !!f).map((f) => [f.profileId, f]))
      if (!byId.size) return
      setMentions(
        latest.current.map((m) => {
          const f = byId.get(m.profileId)
          return f ? { ...m, picture: m.picture ?? f.picture, headline: m.headline ?? f.headline, url: m.url ?? f.url } : m
        }),
      )
    })()
  }, [mentions, setMentions])

  /** Enter only picks once you've moved with the arrow keys, so it never eats a normal new line. */
  const [navigated, setNavigated] = useState(false)

  // Look at the text just before the caret after every edit or caret move.
  const check = () => {
    const el = textarea.current
    if (!el || el.selectionStart !== el.selectionEnd) return setQuery(null)
    const caret = el.selectionStart
    const m = TYPING.exec(el.value.slice(0, caret))
    if (!m || m[1].length < 2) return setQuery(null)
    const start = caret - m[1].length - 1
    // Already tagged exactly as typed: nothing to suggest.
    if (mentions.some((x) => m[1] === x.name || m[1].startsWith(x.name + ' '))) return setQuery(null)
    setQuery({ q: m[1], start, end: caret })
  }

  // Debounced search.
  const q = query?.q
  useEffect(() => {
    if (!q) {
      setResults([])
      setError('')
      return
    }
    setResults([])
    setNavigated(false)
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setLoading(true)
      setError('')
      try {
        const r = await searchMentions(q, ctl.signal)
        setResults(r)
        setSearched(q)
        setActive(0)
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : 'Search failed')
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, 350)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [q])

  const pick = (r: Mention) => {
    if (!query) return
    const { degree: _degree, ...tag } = r
    // Replace only the typed words that match the start of the picked name, so
    // "@Jane today" + "Jane Doe" keeps "today": "@Jane Doe today".
    const typed = query.q.split(' ')
    const want = r.name.toLowerCase().split(/\s+/)
    let keep = 1
    while (keep < typed.length && keep < want.length && want[keep].startsWith(typed[keep].toLowerCase())) keep++
    const end = query.start + 1 + typed.slice(0, keep).join(' ').length
    const insert = `@${r.name}`
    const after = text.slice(end)
    const next = text.slice(0, query.start) + insert + (after.startsWith(' ') ? '' : ' ') + after
    setText(next)
    setMentions([...mentions.filter((m) => m.name !== r.name), tag])
    setQuery(null)
    const caret = query.start + insert.length + 1
    requestAnimationFrame(() => {
      textarea.current?.focus()
      textarea.current?.setSelectionRange(caret, caret)
    })
  }

  /** Arrow keys, Enter/Tab to pick, Escape to close. Returns true if it used the key. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!query || !results.length || searched !== query.q) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setNavigated(true)
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length)
      return true
    }
    if ((e.key === 'Enter' && navigated) || e.key === 'Tab') {
      e.preventDefault()
      pick(results[active])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setQuery(null)
      return true
    }
    return false
  }

  /** Search for an @name that's in the text but not tagged, and let a pick replace it. */
  const findFor = (name: string) => {
    const at = text.search(mentionRegex(name))
    if (at < 0) return
    setQuery({ q: name, start: at, end: at + name.length + 1 })
  }

  const inText = (m: Mention) => mentionRegex(m.name).test(text)
  const tagged = new Set(mentions.filter(inText).map((m) => m.name))
  const untagged = [...new Set([...text.matchAll(AT_NAMES)].map((m) => m[1]))].filter(
    (n) => ![...tagged].some((t) => n === t || n.startsWith(t + ' ')),
  )

  const dropdown = query && (
    <div className="mt-pop" role="listbox" aria-label="People and companies to tag">
      <div className="mt-pop-head">
        Tag <strong>@{query.q}</strong>
        {loading && <span className="muted"> · searching LinkedIn…</span>}
      </div>
      {error && <div className="mt-empty">{error}</div>}
      {!loading && !error && !results.length && searched === query.q && <div className="mt-empty">Nobody found on LinkedIn. Keep typing.</div>}
      {results.map((r, i) => (
        <button
          key={r.profileId}
          role="option"
          aria-selected={i === active}
          className={`mt-row ${i === active ? 'active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(r)}
        >
          <Avatar m={r} />
          <span className="mt-who">
            <span className="mt-name">
              {r.name}
              {r.isCompany ? <span className="mt-badge">Company</span> : r.degree && <span className="mt-deg">{r.degree}°</span>}
            </span>
            {r.headline && <span className="mt-head">{r.headline}</span>}
          </span>
        </button>
      ))}
      <div className="mt-pop-foot">Click or Tab to tag · ↑↓ then Enter · Esc to close</div>
    </div>
  )

  const panel = (mentions.length > 0 || untagged.length > 0) && (
    <div className="mt-panel">
      <span className="field-label">Tags</span>
      {mentions.map((m) => (
        <div key={m.name} className={`mt-tag ${inText(m) ? '' : 'stale'}`}>
          <Avatar m={m} />
          <span className="mt-who">
            <span className="mt-name">
              {m.name}
              {m.isCompany && <span className="mt-badge">Company</span>}
            </span>
            <span className="mt-head">
              {inText(m) ? (m.headline ?? 'Tagged') : `Not in the text any more, so won't be tagged`}
            </span>
          </span>
          {m.url && (
            <a className="btn ghost sm" href={m.url} target="_blank" rel="noreferrer">
              Profile ↗
            </a>
          )}
          <button
            className="btn ghost sm"
            onClick={() => setMentions(mentions.filter((x) => x.name !== m.name))}
            aria-label={`Untag ${m.name}`}
          >
            Untag
          </button>
        </div>
      ))}
      {untagged.map((n) => (
        <div key={n} className="mt-tag untagged">
          <span className="mt-avatar mt-initials">@</span>
          <span className="mt-who">
            <span className="mt-name">@{n}</span>
            <span className="mt-head">Not tagged, goes out as plain text</span>
          </span>
          <button className="btn ghost sm" onClick={() => findFor(n)}>
            Find on LinkedIn
          </button>
        </div>
      ))}
    </div>
  )

  /** Tags whose name is still in the post or first comment: the ones worth saving. */
  const live = mentions.filter((m) => mentionRegex(m.name).test(text + '\n' + (props.comment ?? '')))

  return { check, onKeyDown, dropdown, panel, live }
}
