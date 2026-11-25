import { useCallback, useEffect, useState } from 'react'
import { Face, ReactButton, ago, readJSON, writeJSON } from './Comments'
import { Changes } from './Previews'
import { Riff } from './Riff'
import {
  type EngageSettings,
  type FeedPost,
  type Mention,
  draftComment,
  fetchEngage,
  saveEngage,
  searchMentions,
  sendReply,
} from './store'

const SKIP_KEY = 'engage-skipped'
const DRAFT_KEY = (id: string) => `engage-draft:${id}`

/**
 * Posts worth a comment: your watchlist's latest posts first, then topic searches filtered to posts
 * with real engagement. Claude drafts a comment; nothing goes out until you press Comment.
 */
export function EngageView(props: { toast: (m: string) => void }) {
  const [settings, setSettings] = useState<EngageSettings | null>(null)
  const [posts, setPosts] = useState<FeedPost[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [skipped, setSkipped] = useState<string[]>(() => readJSON(SKIP_KEY, []))
  const [done, setDone] = useState<string[]>([])
  const [sending, setSending] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchEngage()
      setSettings(r.settings)
      setPosts(r.posts)
      setErrors(r.errors)
      if (!r.settings.watchlist.length && !r.settings.topics.length) setEditing(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load posts')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const list = (posts ?? []).filter((p) => !done.includes(p.socialId) && !skipped.includes(p.socialId))
  const current = list.find((p) => p.socialId === selected) ?? list[0] ?? null
  const next = (id: string) => {
    const i = list.findIndex((p) => p.socialId === id)
    setSelected(list[i + 1]?.socialId ?? list[i - 1]?.socialId ?? null)
  }

  return (
    <div className="cockpit">
      <header className="page-head">
        <h1>Comments</h1>
        <p className="muted">
          {posts ? `${list.length} posts worth a comment` : 'Finding posts worth a comment'} · watchlist and topics
          {skipped.length > 0 && (
            <>
              {' · '}
              <button
                className="link"
                onClick={() => {
                  setSkipped([])
                  writeJSON(SKIP_KEY, [])
                }}
              >
                Bring back {skipped.length} skipped
              </button>
            </>
          )}
        </p>
        <button className="btn ghost sm" onClick={() => setEditing(!editing)}>
          {editing ? 'Close settings' : 'Who & what to follow'}
        </button>
        <button className="btn ghost sm" onClick={load} disabled={loading}>
          {loading ? 'Searching LinkedIn…' : 'Refresh'}
        </button>
      </header>

      {editing && settings && (
        <SettingsPanel
          settings={settings}
          onSave={async (s) => {
            try {
              await saveEngage(s)
              setSettings(s)
              setEditing(false)
              props.toast('Saved. Finding posts…')
              load()
            } catch (e) {
              props.toast(e instanceof Error ? e.message : 'Could not save')
            }
          }}
        />
      )}

      {error && <p className="form-hint">{error}</p>}
      {errors.length > 0 && <p className="form-hint">{errors.join(' · ')}</p>}
      {!posts && loading && <p className="muted">Reading your watchlist and searching your topics…</p>}
      {posts && !list.length && !loading && (
        <div className="ck-empty">Nothing new worth a comment. Add people or topics, or check back later.</div>
      )}

      {current && (
        <div className="ck-layout">
          <div className="ck-list">
            {list.map((p) => (
              <button
                key={p.socialId}
                className={`ck-item ${current.socialId === p.socialId ? 'on' : ''}`}
                onClick={() => setSelected(p.socialId)}
              >
                <Face c={p} />
                <span className="ck-item-main">
                  <span className="ck-item-top">
                    <strong>{p.author}</strong>
                    <span className="muted">{ago(p.date)}</span>
                  </span>
                  <span className="ck-item-text">{p.text}</span>
                  <span className="en-meta">
                    <span className={`en-src ${p.source}`}>{p.source === 'watchlist' ? 'Watchlist' : p.topic}</span>
                    <span>👍 {p.reactions}</span>
                    <span>💬 {p.comments}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
          <CommentPanel
            key={current.socialId}
            post={current}
            sending={sending.includes(current.socialId)}
            onSending={(on) => {
              const id = current.socialId
              setSending((s) => (on ? [...s, id] : s.filter((x) => x !== id)))
            }}
            onSkip={() => {
              const s = [...skipped, current.socialId]
              setSkipped(s)
              writeJSON(SKIP_KEY, s)
              next(current.socialId)
            }}
            toast={props.toast}
            onDone={() => {
              const { socialId, author } = current
              setDone((d) => [...d, socialId])
              props.toast(`Commented on ${author}'s post`)
              next(socialId)
            }}
          />
        </div>
      )}
    </div>
  )
}

function SettingsPanel(props: { settings: EngageSettings; onSave: (s: EngageSettings) => void }) {
  const [watch, setWatch] = useState(props.settings.watchlist)
  const [topics, setTopics] = useState(props.settings.topics)
  const [min, setMin] = useState(props.settings.minReactions)
  const [topic, setTopic] = useState('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Mention[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([])
      return
    }
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        setResults((await searchMentions(q.trim(), ctl.signal)).filter((r) => !r.isCompany))
      } catch {
        if (!ctl.signal.aborted) setResults([])
      } finally {
        if (!ctl.signal.aborted) setSearching(false)
      }
    }, 350)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [q])

  const addTopic = () => {
    const t = topic.trim()
    if (t.length >= 2 && !topics.includes(t)) setTopics([...topics, t])
    setTopic('')
  }

  return (
    <div className="en-settings">
      <div className="en-col">
        <span className="field-label">Watchlist · people whose posts you want to comment on</span>
        <div className="en-chips">
          {watch.map((w) => (
            <span key={w.profileId} className="en-chip" title={w.headline}>
              {w.name}
              <button onClick={() => setWatch(watch.filter((x) => x.profileId !== w.profileId))} aria-label={`Remove ${w.name}`}>
                ×
              </button>
            </span>
          ))}
          {!watch.length && <span className="muted">Nobody yet</span>}
        </div>
        <input className="en-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a person: type a name" />
        {(searching || results.length > 0) && (
          <div className="mt-pop">
            {searching && <div className="mt-empty">Searching LinkedIn…</div>}
            {results.map((r) => (
              <button
                key={r.profileId}
                className="mt-row"
                onClick={() => {
                  if (!watch.some((w) => w.profileId === r.profileId))
                    setWatch([...watch, { name: r.name, profileId: r.profileId, headline: r.headline, picture: r.picture, url: r.url }])
                  setQ('')
                }}
              >
                <Face c={{ author: r.name, picture: r.picture }} size={30} />
                <span className="mt-who">
                  <span className="mt-name">
                    {r.name}
                    {r.degree && <span className="mt-deg">{r.degree}°</span>}
                  </span>
                  {r.headline && <span className="mt-head">{r.headline}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="en-col">
        <span className="field-label">Topics · searched for posts from the last week</span>
        <div className="en-chips">
          {topics.map((t) => (
            <span key={t} className="en-chip">
              {t}
              <button onClick={() => setTopics(topics.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                ×
              </button>
            </span>
          ))}
          {!topics.length && <span className="muted">No topics yet</span>}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            addTopic()
          }}
        >
          <input className="en-input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Add a topic, e.g. future of work" />
        </form>
        <label className="en-min">
          Only topic posts with at least
          <input type="number" min={0} max={5000} value={min} onChange={(e) => setMin(Math.max(0, Number(e.target.value) || 0))} />
          reactions
        </label>
      </div>
      <div className="en-save">
        <button className="btn primary sm" onClick={() => props.onSave({ watchlist: watch, topics, minReactions: min })}>
          Save and refresh
        </button>
      </div>
    </div>
  )
}

function CommentPanel(props: {
  post: FeedPost
  sending: boolean
  onSending: (on: boolean) => void
  onSkip: () => void
  onDone: () => void
  toast: (m: string) => void
}) {
  const p = props.post
  const [text, setText] = useState(() => readJSON<string>(DRAFT_KEY(p.socialId), ''))
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState('')
  const [previewing, setPreviewing] = useState<{ label: string; text: string } | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  // A fresh Claude draft starts a fresh Claude panel, so old suggestions never land on new text.
  const [draftNo, setDraftNo] = useState(0)
  const setDraft = (t: string) => {
    setText(t)
    writeJSON(DRAFT_KEY(p.socialId), t)
  }

  const draft = useCallback(async () => {
    setDrafting(true)
    setError('')
    try {
      setDraft(await draftComment(p))
      setDraftNo((n) => n + 1)
      setPreviewing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Claude could not draft that')
    } finally {
      setDrafting(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p])

  useEffect(() => {
    if (!readJSON<string>(DRAFT_KEY(p.socialId), '')) draft()
    // Draft once when you open a post; Redo asks for another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = async () => {
    const body = text.trim()
    if (!body || props.sending) return
    props.onSending(true)
    setError('')
    try {
      await sendReply({ socialId: p.socialId, text: body })
      try {
        localStorage.removeItem(DRAFT_KEY(p.socialId))
      } catch {
        /* nothing to clean up */
      }
      props.onSending(false)
      props.onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comment failed')
      props.onSending(false)
    }
  }

  const context = `${p.author}${p.headline ? ` (${p.headline})` : ''} posted on LinkedIn, and I'm commenting on it:\n${p.text.slice(0, 5000)}`

  return (
    <div className="ck-panel">
      <div className="ck-comment">
        <Face c={p} size={44} />
        <div className="ck-comment-main">
          <div className="ck-comment-who">
            <strong>{p.author}</strong>
            <span className="muted">{ago(p.date)} ago</span>
            {p.url && (
              <a className="link" href={p.url} target="_blank" rel="noreferrer">
                Open on LinkedIn ↗
              </a>
            )}
          </div>
          {p.headline && <div className="ck-comment-headline">{p.headline}</div>}
          <p className="ck-comment-text en-post-text">{p.text}</p>
          <div className="en-meta">
            <span>👍 {p.reactions}</span>
            <span>💬 {p.comments}</span>
          </div>
        </div>
      </div>

      <div className="ck-reply">
        <span className="field-label">Your comment {drafting && <span className="muted">· Claude is drafting…</span>}</span>
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
                Back to my comment
              </button>
            </div>
            <p className="ck-diff-text">
              <Changes from={text} to={previewing.text} />
            </p>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={drafting ? 'Drafting a comment in your voice…' : 'Write a comment'}
          rows={4}
          disabled={drafting}
        />
        {error && <p className="form-hint">{error}</p>}
        <div className="ck-actions">
          <ReactButton socialId={p.socialId} what="post" toast={props.toast} />
          <span className="spacer" />
          <button className="btn ghost sm" onClick={props.onSkip}>
            Skip
          </button>
          <button className="btn ghost sm" onClick={draft} disabled={drafting}>
            Redo draft
          </button>
          <button className="btn primary sm" onClick={send} disabled={props.sending || drafting || !text.trim()}>
            {props.sending ? 'Commenting…' : 'Comment on LinkedIn'}
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
            setDraft(t)
          }}
          onUndo={() => {
            if (undo === null) return
            setDraft(undo)
            setUndo(null)
          }}
          onPreview={setPreviewing}
          previewText={previewing?.text}
        />
      )}
    </div>
  )
}
