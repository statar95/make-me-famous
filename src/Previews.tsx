import { type ReactNode, useState } from 'react'
import { diffWords } from './diff'
import { type Profile, LIMITS, countFor, mediaUrl, splitThread } from './store'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/** On LinkedIn an @name you haven't tagged is plain text, so only X gets blue @handles. */
function Linkify({ text, atLinks = true }: { text: string; atLinks?: boolean }) {
  const parts = text.split(/(\s+)/)
  return (
    <>
      {parts.map((p, i) =>
        /^(https?:\/\/|[a-z0-9-]+\.[a-z]{2,}\/)/i.test(p) || (atLinks ? /^[#@]\w+/ : /^#\w+/).test(p) ? (
          <span key={i} className="pv-link">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  )
}

export function Meter({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(used / limit, 1)
  const over = used > limit
  const r = 9
  const c = 2 * Math.PI * r
  return (
    <span className={`meter ${over ? 'over' : pct > 0.9 ? 'warn' : ''}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r={r} className="meter-track" />
        <circle
          cx="11"
          cy="11"
          r={r}
          className="meter-fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span className="meter-num">
        {used.toLocaleString()} / {limit.toLocaleString()}
      </span>
    </span>
  )
}

/** Roughly how LinkedIn lays out a multi-image post: one big, then a row, then "+N". */
function MediaGrid({ media }: { media: string[] }) {
  if (!media.length) return null
  const shown = media.slice(0, media.length > 4 ? 4 : media.length)
  const extra = media.length - shown.length
  return (
    <div className={`pv-media n${Math.min(media.length, 4)}`}>
      {shown.map((m, i) => (
        <div key={m} className="pv-media-cell">
          <img src={mediaUrl(m)} alt="" />
          {extra > 0 && i === shown.length - 1 && <span className="pv-media-more">+{extra}</span>}
        </div>
      ))}
    </div>
  )
}

/** Tagged names show as LinkedIn shows them: the name in link colour, without the @. */
function Tagged({ text, tags }: { text: string; tags: string[] }) {
  const names = [...tags].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!names.length) return <Linkify text={text} atLinks={false} />
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}_./@])@(${names.map(esc).join('|')})(?![\\p{L}\\p{N}_])`, 'gu')
  const out: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    out.push(<Linkify key={`t${last}`} text={text.slice(last, m.index)} atLinks={false} />)
    out.push(
      <span key={`m${m.index}`} className="pv-mention">
        {m[1]}
      </span>,
    )
    last = m.index! + m[0].length
  }
  out.push(<Linkify key="end" text={text.slice(last)} atLinks={false} />)
  return <>{out}</>
}

function Face({ name, picture, size, square }: { name: string; picture?: string; size: number; square?: boolean }) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size, borderRadius: square ? 4 : '50%' }
  return picture && !broken ? (
    <img className="li-face" style={style} src={picture} alt="" onError={() => setBroken(true)} />
  ) : (
    <div className="avatar li-face" style={{ ...style, fontSize: size * 0.34 }}>
      {initials(name)}
    </div>
  )
}

const Icon = {
  like: 'M19.46 11l-3.91-3.91a7 7 0 01-1.69-2.74l-.49-1.47A2.76 2.76 0 0010.76 1 2.75 2.75 0 008 3.74v1.12a9.19 9.19 0 00.46 2.85L8.89 9H4.12A2.12 2.12 0 002 11.12a2.16 2.16 0 00.92 1.76A2.11 2.11 0 002 14.62a2.14 2.14 0 001.28 2 2 2 0 00-.28 1 2.12 2.12 0 002 2.12v.14A2.12 2.12 0 007.12 22h7.49a8.08 8.08 0 003.58-.84l.31-.16H21V11z',
  comment: 'M7 9h10v1H7zm0 4h7v-1H7zm16-2a6.78 6.78 0 01-2.84 5.61L12 22v-4H8A7 7 0 018 4h8a7 7 0 017 7zm-2 0a5 5 0 00-5-5H8a5 5 0 000 10h6v2.28L19 15a4.79 4.79 0 002-4z',
  repost: 'M13.96 5H6c-.55 0-1 .45-1 1v10H3V6c0-1.66 1.34-3 3-3h7.96L12 0h2.37L17 4l-2.63 4H12l1.96-3zm5.04 3v10c0 .55-.45 1-1 1h-7.96L12 16H9.63L7 20l2.63 4H12l-1.96-3H18c1.66 0 3-1.34 3-3V8h-2z',
  send: 'M21 3L0 10l7.66 4.26L16 8l-6.26 8.34L14 24l7-21z',
}
function Action({ d, label }: { d: string; label: string }) {
  return (
    <span className="li-action">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        <path d={d} fill="currentColor" />
      </svg>
      {label}
    </span>
  )
}

/** As close to the LinkedIn feed as we can get: real photo, type sizes, colours, fold, tags. */
/** Track changes: what Claude would remove in red, what it would add in green. */
export function Changes({ from, to }: { from: string; to: string }) {
  return (
    <>
      {diffWords(from, to).map((p, i) =>
        p.kind === 'same' ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === 'del' ? (
          <del key={i} className="chg-del">
            {p.text}
          </del>
        ) : (
          <ins key={i} className="chg-add">
            {p.text}
          </ins>
        ),
      )}
    </>
  )
}

export function LinkedInPreview({
  text,
  profile,
  media = [],
  tags = [],
  compareTo,
}: {
  text: string
  profile: Profile
  media?: string[]
  tags?: string[]
  /** When set, the body shows track changes from `text` to this. */
  compareTo?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const FOLD = 210
  const chars = [...text]
  const folded = compareTo === undefined && !expanded && (chars.length > FOLD || text.split('\n').length > 3)
  const shown = folded ? chars.slice(0, FOLD).join('').split('\n').slice(0, 3).join('\n').trimEnd() : text
  const used = countFor('linkedin', text)
  return (
    <div className="pv pv-li">
      <div className="pv-head">
        <span className="pv-tag li">LinkedIn</span>
        <Meter used={used} limit={LIMITS.linkedin} />
      </div>
      <div className="li-card">
        <div className="li-author">
          <Face name={profile.name} picture={profile.picture} size={48} />
          <div className="li-meta">
            <div className="li-name">
              {profile.name} <span className="li-you">• You</span>
            </div>
            <div className="li-headline">{profile.headline}</div>
            <div className="li-time">Now • 🌐︎</div>
          </div>
        </div>
        <div className="li-body">
          {compareTo !== undefined ? (
            <Changes from={text} to={compareTo} />
          ) : text ? (
            <Tagged text={shown} tags={tags} />
          ) : (
            <span className="pv-empty">Your post will appear here.</span>
          )}
          {folded && (
            <button className="li-more" onClick={() => setExpanded(true)}>
              …more
            </button>
          )}
        </div>
        <MediaGrid media={media} />
        <div className="li-actions">
          <Action d={Icon.like} label="Like" />
          <Action d={Icon.comment} label="Comment" />
          <Action d={Icon.repost} label="Repost" />
          <Action d={Icon.send} label="Send" />
        </div>
      </div>
      {folded && <p className="pv-hint">The first ~210 characters show before "…more". Make them count.</p>}
    </div>
  )
}

/** The first comment as it'll sit under the post. */
export function LinkedInComment({ text, profile, tags = [] }: { text: string; profile: Profile; tags?: string[] }) {
  return (
    <div className="li-comment">
      <Face name={profile.name} picture={profile.picture} size={32} />
      <div className="li-bubble">
        <div className="li-name sm">
          {profile.name} <span className="li-author-badge">Author</span>
        </div>
        <div className="li-headline">{profile.headline}</div>
        <div className="li-body sm">
          <Tagged text={text} tags={tags} />
        </div>
      </div>
    </div>
  )
}

export function XPreview({ text, profile }: { text: string; profile: Profile }) {
  const tweets = splitThread(text)
  const used = countFor('x', text)
  const thread = tweets.length > 1
  return (
    <div className="pv pv-x">
      <div className="pv-head">
        <span className="pv-tag x">X</span>
        {thread ? (
          <span className="meter warn">
            <span className="meter-num">Thread of {tweets.length}</span>
          </span>
        ) : (
          <Meter used={used} limit={LIMITS.x} />
        )}
      </div>
      <div className="pv-card x">
        {tweets.map((t, i) => (
          <div className="tweet" key={i}>
            <div className="tweet-rail">
              <div className="avatar x">{initials(profile.name)}</div>
              {i < tweets.length - 1 && <div className="tweet-line" />}
            </div>
            <div className="tweet-main">
              <div className="pv-name">
                {profile.name} <span className="pv-sub inline">@{profile.handle} · now</span>
              </div>
              <div className="pv-body">
                {t ? <Linkify text={t} /> : <span className="pv-empty">Your post will appear here.</span>}
              </div>
              <div className="pv-actions x">
                <span>💬</span>
                <span>🔁</span>
                <span>♡</span>
                <span>↗</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {thread && (
        <p className="pv-hint">
          {used} weighted characters is over X's 280, so this will go out as a {tweets.length}-post thread.
        </p>
      )}
    </div>
  )
}
