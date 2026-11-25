import { useCallback, useEffect, useMemo, useState } from 'react'
import { Changes } from './Previews'
import { Riff } from './Riff'
import { type CockpitComment, type CockpitPost, type Post, type Reaction, draftReply, fetchComments, react, sendReply } from './store'

// Per-browser memory: comments you skipped, and drafts already written (so reopening doesn't pay again).
const SKIP_KEY = 'cockpit-skipped'
const DRAFT_KEY = (id: string) => `cockpit-draft:${id}`
export const readJSON = <T,>(k: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
export const writeJSON = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage blocked: the cockpit still works, it just won't remember */
  }
}

export const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(m)) return ''
  if (m < 60) return `${Math.max(m, 1)}m`
  if (m < 60 * 24) return `${Math.round(m / 60)}h`
  return `${Math.round(m / 1440)}d`
}
const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

const REACTIONS: { r: Reaction; label: string }[] = [
  { r: 'like', label: '👍 Like' },
  { r: 'insightful', label: '💡 Insightful' },
  { r: 'celebrate', label: '👏 Celebrate' },
  { r: 'funny', label: '😄 Funny' },
  { r: 'love', label: '❤️ Love' },
  { r: 'support', label: '🤲 Support' },
]

/** Like (or another reaction) on LinkedIn, for a post or a comment. Remembers what you picked in this browser. */
export function ReactButton(props: { socialId: string; commentId?: string; what: string; toast: (m: string) => void }) {
  const key = `reacted:${props.socialId}:${props.commentId ?? ''}`
  const [done, setDone] = useState<Reaction | null>(() => readJSON<Reaction | null>(key, null))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const go = async (r: Reaction) => {
    setOpen(false)
    if (busy) return
    setBusy(true)
    try {
      await react(props.socialId, r, props.commentId)
      setDone(r)
      writeJSON(key, r)
      props.toast(`Reacted to the ${props.what}`)
    } catch (e) {
      props.toast(e instanceof Error ? e.message : 'Reaction failed')
    } finally {
      setBusy(false)
    }
  }
  const picked = REACTIONS.find((x) => x.r === done)
  return (
    <span className="react">
      <button className={`btn sm ${done ? 'ready-on' : 'ghost'}`} onClick={() => go(done ?? 'like')} disabled={busy || !!done}>
        {busy ? '…' : picked ? `${picked.label} ✓` : `👍 Like ${props.what}`}
      </button>
      {!done && (
        <button className="btn ghost sm react-more" onClick={() => setOpen(!open)} aria-label="Other reactions">
          ▾
        </button>
      )}
      {open && (
        <span className="react-menu">
          {REACTIONS.map((x) => (
            <button key={x.r} onClick={() => go(x.r)}>
              {x.label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

export function Face({ c, size = 36 }: { c: { author: string; picture?: string }; size?: number }) {
  const [broken, setBroken] = useState(false)
  return c.picture && !broken ? (
    <img className="ck-face" style={{ width: size, height: size }} src={c.picture} alt="" onError={() => setBroken(true)} />
  ) : (
    <span className="ck-face ck-initials" style={{ width: size, height: size }}>
      {initials(c.author)}
    </span>
  )
}

/**
 * The comment cockpit: everything people said on your last week of posts that you haven't answered,
 * with a reply Claude drafts in your voice. Nothing goes to LinkedIn until you press Reply.
 */
export function CommentsView(props: { posts: Post[]; toast: (m: string) => void; onCount: (n: number) => void }) {
  const [data, setData] = useState<CockpitPost[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState<string[]>(() => readJSON(SKIP_KEY, []))
  const [showSkipped, setShowSkipped] = useState(false)
  const [replied, setReplied] = useState<string[]>([])
  const [sending, setSending] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await fetchComments())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load comments')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const visible = useMemo(
    () =>
      (data ?? [])
        .map((p) => ({
          ...p,
          comments: p.comments
            .filter((c) => !replied.includes(c.id) && (showSkipped || !skipped.includes(c.id)))
            .sort((a, b) => b.date.localeCompare(a.date)),
        }))
        .filter((p) => p.comments.length || p.error),
    [data, replied, skipped, showSkipped],
  )
  const waiting = (data ?? []).reduce(
    (n, p) => n + p.comments.filter((c) => !replied.includes(c.id) && !skipped.includes(c.id)).length,
    0,
  )
  const { onCount } = props
  useEffect(() => {
    onCount(waiting)
  }, [waiting, onCount])

  const flat = visible.flatMap((p) => p.comments.map((c) => ({ post: p, c })))
  const current = flat.find((x) => x.c.id === selected) ?? flat[0] ?? null

  // Full text of your post when the app sent it, otherwise LinkedIn's preview.
  const postText = (p: CockpitPost) =>
    props.posts.find((x) => x.results?.some((r) => r.socialId === p.socialId))?.text ?? p.preview

  const next = (id: string) => {
    const i = flat.findIndex((x) => x.c.id === id)
    setSelected(flat[i + 1]?.c.id ?? flat[i - 1]?.c.id ?? null)
  }
  const skip = (id: string) => {
    const s = [...skipped, id]
    setSkipped(s)
    writeJSON(SKIP_KEY, s)
    next(id)
  }
  const unskip = (id: string) => {
    const s = skipped.filter((x) => x !== id)
    setSkipped(s)
    writeJSON(SKIP_KEY, s)
  }

  return (
    <div className="cockpit">
      <header className="page-head">
        <h1>Replies</h1>
        <p className="muted">
          {data ? `${waiting} waiting for a reply · last 7 days` : 'Last 7 days'}
          {skipped.length > 0 && (
            <>
              {' · '}
              <button className="link" onClick={() => setShowSkipped(!showSkipped)}>
                {showSkipped ? 'Hide skipped' : `Show ${skipped.length} skipped`}
              </button>
            </>
          )}
        </p>
        <button className="btn ghost sm" onClick={load} disabled={loading}>
          {loading ? 'Checking LinkedIn…' : 'Refresh'}
        </button>
      </header>

      {error && <p className="form-hint">{error}</p>}
      {!data && loading && <p className="muted">Reading the comments on your recent posts…</p>}
      {data && !flat.length && !loading && (
        <div className="ck-empty">Inbox zero. Nobody's waiting on you 🎉</div>
      )}

      {flat.length > 0 && current && (
        <div className="ck-layout">
          <div className="ck-list">
            {visible.map((p) => (
              <section key={p.socialId} className="ck-group">
                <div className="ck-post">
                  <span className="ck-post-when">{ago(p.date)} ago</span>
                  <span className="ck-post-text">{p.preview}</span>
                  {p.error && <span className="form-hint">{p.error}</span>}
                </div>
                {p.comments.map((c) => (
                  <button
                    key={c.id}
                    className={`ck-item ${current.c.id === c.id ? 'on' : ''} ${skipped.includes(c.id) ? 'skipped' : ''}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <Face c={c} />
                    <span className="ck-item-main">
                      <span className="ck-item-top">
                        <strong>{c.author}</strong>
                        <span className="muted">{ago(c.date)}</span>
                      </span>
                      <span className="ck-item-text">{c.text}</span>
                    </span>
                  </button>
                ))}
              </section>
            ))}
          </div>
          <ReplyPanel
            key={current.c.id}
            post={current.post}
            postText={postText(current.post)}
            c={current.c}
            isSkipped={skipped.includes(current.c.id)}
            sending={sending.includes(current.c.id)}
            onSending={(on) => {
              const id = current.c.id
              setSending((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
            }}
            onSkip={() => skip(current.c.id)}
            onUnskip={() => unskip(current.c.id)}
            onReplied={() => {
              const { id, author } = current.c
              setReplied((r) => [...r, id])
              props.toast(`Replied to ${author}`)
              next(id)
            }}
            toast={props.toast}
          />
        </div>
      )}
    </div>
  )
}

function ReplyPanel(props: {
  post: CockpitPost
  postText: string
  c: CockpitComment
  isSkipped: boolean
  onSkip: () => void
  onUnskip: () => void
  onReplied: () => void
  sending: boolean
  onSending: (on: boolean) => void
  toast: (m: string) => void
}) {
  const { c } = props
  const [text, setText] = useState(() => readJSON<string>(DRAFT_KEY(c.id), ''))
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState('')
  const [tag, setTag] = useState(false)
  const [previewing, setPreviewing] = useState<{ label: string; text: string } | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  // A fresh Claude draft starts a fresh Claude panel, so old suggestions never land on new text.
  const [draftNo, setDraftNo] = useState(0)
  const setReply = (t: string) => {
    setText(t)
    writeJSON(DRAFT_KEY(c.id), t)
  }
  const context = [
    `${c.author}${c.headline ? ` (${c.headline})` : ''} commented on my post:`,
    c.text,
    ...c.replies.map((r) => `Reply from ${r.author}: ${r.text}`),
    '',
    `My post (opening): ${props.postText.slice(0, 1500)}`,
  ].join('\n')
  const canTag = c.author !== 'Someone' && c.author.length <= 100 && /^(AC|AD)[A-Za-z0-9_-]+$/.test(c.authorId)

  const draft = useCallback(async () => {
    setDrafting(true)
    setError('')
    try {
      const d = await draftReply(props.postText, c)
      setText(d)
      writeJSON(DRAFT_KEY(c.id), d)
      setDraftNo((n) => n + 1)
      setPreviewing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claude could not draft that')
    } finally {
      setDrafting(false)
    }
  }, [props.postText, c])

  useEffect(() => {
    if (!readJSON<string>(DRAFT_KEY(c.id), '')) draft()
    // Draft once when you open a comment; Redo asks for another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async () => {
    const body = text.trim()
    if (!body || props.sending) return
    props.onSending(true)
    setError('')
    try {
      await sendReply({
        socialId: props.post.socialId,
        commentId: c.id,
        text: tag && canTag ? `@${c.author} ${body}` : body,
        mentions: tag && canTag ? [{ name: c.author, profileId: c.authorId }] : undefined,
      })
      try {
        localStorage.removeItem(DRAFT_KEY(c.id))
      } catch {
        /* nothing to clean up */
      }
      props.onSending(false)
      props.onReplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reply failed')
      props.onSending(false)
    }
  }

  return (
    <div className="ck-panel">
      <div className="ck-panel-post">
        <span className="field-label">Your post</span>
        <p>{props.post.preview}</p>
        {props.post.url && (
          <a className="link" href={props.post.url} target="_blank" rel="noreferrer">
            Open on LinkedIn ↗
          </a>
        )}
      </div>

      <div className="ck-comment">
        <Face c={c} size={44} />
        <div className="ck-comment-main">
          <div className="ck-comment-who">
            <strong>{c.author}</strong>
            {c.degree && <span className="mt-deg">{c.degree}</span>}
            {c.profileUrl && (
              <a className="link" href={c.profileUrl} target="_blank" rel="noreferrer">
                Profile ↗
              </a>
            )}
          </div>
          {c.headline && <div className="ck-comment-headline">{c.headline}</div>}
          <p className="ck-comment-text">{c.text}</p>
          {c.replies.length > 0 && (
            <div className="ck-thread">
              {c.replies.map((r, i) => (
                <p key={i}>
                  <strong>{r.author}:</strong> {r.text}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ck-reply">
        <span className="field-label">Your reply {drafting && <span className="muted">· Claude is drafting…</span>}</span>
        {previewing && (
          <div className="ck-diff">
            <div className="diff-banner">
              <span>
                <strong>{previewing.label}</strong>
                <span className="diff-legend">
                  <del className="chg-del">removed</del>
                  <ins className="chg-add">added</ins>
                </span>
              </span>
              <button className="btn ghost sm" onClick={() => setPreviewing(null)}>
                Back to my reply
              </button>
            </div>
            <p className="ck-diff-text">
              <Changes from={text} to={previewing.text} />
            </p>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setReply(e.target.value)}
          placeholder={drafting ? 'Drafting a reply in your voice…' : 'Write a reply'}
          rows={4}
          disabled={drafting}
        />
        {canTag && (
          <label className="ck-tag">
            <input type="checkbox" checked={tag} onChange={(e) => setTag(e.target.checked)} /> Tag {c.author} in the reply
          </label>
        )}
        {error && <p className="form-hint">{error}</p>}
        <div className="ck-actions">
          <ReactButton socialId={props.post.socialId} commentId={c.id} what="comment" toast={props.toast} />
          <span className="spacer" />
          {props.isSkipped ? (
            <button className="btn ghost sm" onClick={props.onUnskip}>
              Unskip
            </button>
          ) : (
            <button className="btn ghost sm" onClick={props.onSkip}>
              Skip
            </button>
          )}
          <button className="btn ghost sm" onClick={draft} disabled={drafting}>
            Redo draft
          </button>
          <button className="btn primary sm" onClick={send} disabled={props.sending || drafting || !text.trim()}>
            {props.sending ? 'Replying…' : 'Reply on LinkedIn'}
          </button>
        </div>
      </div>
      {text.trim() && (
        <Riff
          key={draftNo}
          text={text}
          firstComment=""
          target={{ kind: 'reply', context }}
          canUndo={undo !== null}
          onApply={(t) => {
            if (t === null) return
            setUndo(text)
            setReply(t)
          }}
          onUndo={() => {
            if (undo === null) return
            setReply(undo)
            setUndo(null)
          }}
          onPreview={setPreviewing}
          previewText={previewing?.text}
        />
      )}
    </div>
  )
}
