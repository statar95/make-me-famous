import { useCallback, useEffect, useRef, useState } from 'react'
import { Face, ReactButton, ago, readJSON, writeJSON } from './Comments'
import { Changes } from './Previews'
import { Riff } from './Riff'
import {
  type EngageSettings,
  type EngageStats,
  type FeedPost,
  type Mention,
  type Score,
  type PersonSuggestion,
  type CircleInfo,
  dismissSuggestion,
  draftComment,
  excludeFromCircle,
  fetchEngage,
  fetchMore,
  searchIndustries,
  saveEngage,
  searchMentions,
  sendComment,
} from './store'

const SKIP_KEY = 'engage-skipped'
const DRAFT_KEY = (id: string) => `engage-draft:${id}`

/**
 * Posts worth a comment. Main view: what your circle posted, liked or commented on, only posts already
 * getting traction, ranked by momentum. Also: popular in your sector, and your topics. Claude drafts a
 * comment; nothing goes out until you press Comment.
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
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([])
  const [stats, setStats] = useState<EngageStats | null>(null)
  const [engagersAt, setEngagersAt] = useState<string | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [only, setOnly] = useState<'all' | FeedPost['source']>('feed')
  const [circle, setCircle] = useState<CircleInfo | null>(null)
  const [minDraft, setMinDraft] = useState('')
  const [more, setMore] = useState<FeedPost[] | null>(null)
  const [moreErrors, setMoreErrors] = useState<string[]>([])
  const [moreLoading, setMoreLoading] = useState(false)

  // Only the newest live search may land, so a slow older one can't overwrite it.
  const moreReq = useRef(0)
  const loadMore = useCallback(() => {
    const id = ++moreReq.current
    setMoreLoading(true)
    fetchMore()
      .then((m) => {
        if (id !== moreReq.current) return
        setMore(m.posts)
        setMoreErrors(m.errors)
        setSuggestions(m.suggestions ?? [])
      })
      .catch((e) => {
        if (id === moreReq.current) setMoreErrors([e instanceof Error ? e.message : 'Could not search topics and sector'])
      })
      .finally(() => {
        if (id === moreReq.current) setMoreLoading(false)
      })
  }, [])

  /** The circle feed: from the cache, instant, no LinkedIn calls. */
  const loadFeed = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchEngage()
      setSettings(r.settings)
      setPosts(r.posts)
      setErrors(r.errors)
      setStats(r.stats ?? null)
      setEngagersAt(r.engagersAt ?? null)
      setCircle(r.circle ?? null)
      setMinDraft(String(r.circle?.minReactions ?? r.settings.feedMinReactions ?? 30))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load posts')
    } finally {
      setLoading(false)
    }
  }, [])
  const load = useCallback(() => {
    loadMore()
    loadFeed()
  }, [loadMore, loadFeed])
  useEffect(() => {
    load()
  }, [load])

  const seen = new Set<string>()
  const open = [...(posts ?? []), ...(more ?? [])]
    .filter((p) => (seen.has(p.socialId) ? false : (seen.add(p.socialId), true)))
    .filter((p) => !done.includes(p.socialId) && !skipped.includes(p.socialId))
  const list = only === 'all' ? open : open.filter((p) => p.source === only)
  const count = (src: FeedPost['source']) => open.filter((p) => p.source === src).length
  const current = list.find((p) => p.socialId === selected) ?? list[0] ?? null
  const next = (id: string) => {
    const i = list.findIndex((p) => p.socialId === id)
    setSelected(list[i + 1]?.socialId ?? list[i - 1]?.socialId ?? null)
  }

  return (
    <div className="cockpit">
      <header className="page-head">
        <h1>Comments</h1>
        <div className="muted">
          {!circle
            ? 'Reading your feed…'
            : !circle.builtAt
              ? 'Building your circle. The first posts show up within the hour; then it fills in over the day.'
              : `Your circle: ${circle.size} people (${circle.checkedToday} checked in the last day) · ${circle.cached} posts collected · ${count('feed')} have`}
          {settings && (
            <form
              className="en-min-inline"
              onSubmit={async (e) => {
                e.preventDefault()
                const n = Math.max(0, Math.min(5000, Math.round(Number(minDraft) || 0)))
                try {
                  await saveEngage({ ...settings, feedMinReactions: n })
                  setSettings({ ...settings, feedMinReactions: n })
                  loadFeed()
                } catch (err) {
                  props.toast(err instanceof Error ? err.message : 'Could not save')
                }
              }}
            >
              <input type="number" min={0} max={5000} value={minDraft} onChange={(e) => setMinDraft(e.target.value)} />
              <span>+ reactions</span>
              {settings && minDraft !== String(settings.feedMinReactions ?? 30) && (
                <button className="btn ghost sm" type="submit">
                  Apply
                </button>
              )}
            </form>
          )}
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
        </div>
        <button className="btn ghost sm" onClick={() => setEditing(!editing)}>
          {editing ? 'Close settings' : 'Circle, sector & topics'}
          {!editing && suggestions.length > 0 && <span className="en-count">{suggestions.length}</span>}
        </button>
        <button className="btn ghost sm" onClick={() => setShowStats(!showStats)}>
          {showStats ? 'Close results' : "What's working"}
        </button>
        <button className="btn ghost sm" onClick={load} disabled={loading}>
          {loading ? 'Searching LinkedIn…' : 'Refresh'}
        </button>
      </header>

      {editing && settings && (
        <SettingsPanel
          settings={settings}
          suggestions={suggestions}
          stats={stats}
          engagersAt={engagersAt}
          onDismiss={async (id) => {
            setSuggestions((s) => s.filter((x) => x.profileId !== id))
            try {
              await dismissSuggestion(id)
            } catch (e) {
              props.toast(e instanceof Error ? e.message : 'Could not save that')
            }
          }}
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

      {editing && circle && circle.people.length > 0 && (
        <CirclePanel
          circle={circle}
          onRemove={async (id) => {
            setCircle({ ...circle, people: circle.people.filter((p) => p.id !== id), size: circle.size - 1 })
            // Same rule as the server: their posts go, and posts only there because of them.
            setPosts(
              (ps) => ps?.filter((p) => p.authorId !== id && (!p.via || p.via.some((v) => v.id !== id))) ?? null,
            )
            try {
              await excludeFromCircle(id)
            } catch (e) {
              props.toast(e instanceof Error ? e.message : 'Could not save that')
            }
          }}
        />
      )}

      {showStats && stats && <WhatsWorking stats={stats} settings={settings} />}

      {posts && (
        <div className="en-filter">
          {(
            [
              ['feed', 'Your circle', count('feed')],
              ['sector', 'Popular in your sector', count('sector')],
              ['topic', 'Topics', count('topic')],
              ['all', 'Everything', open.length],
            ] as const
          ).map(([k, label, n]) => (
            <button key={k} className={`en-filter-btn ${only === k ? 'on' : ''}`} onClick={() => setOnly(k)} disabled={!n}>
              {label} <span className="muted">{n}</span>
            </button>
          ))}
          {moreLoading && <span className="muted">Searching your sector and topics…</span>}
        </div>
      )}

      {error && <p className="form-hint">{error}</p>}
      {[...errors, ...moreErrors].length > 0 && <p className="form-hint">{[...errors, ...moreErrors].join(' · ')}</p>}
      {!posts && loading && <p className="muted">Reading your feed…</p>}
      {posts && !list.length && !loading && !(only !== 'feed' && moreLoading) && (
        <div className="ck-empty">
          {only === 'feed'
            ? 'Nothing from your circle over that many reactions right now. Lower the number, or check back later: it fills in through the day.'
            : only === 'sector' && !settings?.industries?.length
              ? 'Pick your industries under "Circle, sector & topics" to see what\'s popular in your sector.'
              : 'Nothing new here. Check back later.'}
        </div>
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
                    <span className={`en-src ${p.source}`}>
                      {p.source === 'feed' ? 'Circle' : p.source === 'sector' ? 'Sector' : p.source === 'watchlist' ? 'Watchlist' : p.topic}
                    </span>
                    <span>👍 {p.reactions}</span>
                    <span>💬 {p.comments}</span>
                    {p.authorId && stats?.byPerson[p.authorId] && <History s={stats.byPerson[p.authorId]} />}
                  </span>
                  {p.via && p.via.length > 0 && <ViaLine via={p.via} author={p.authorId} />}
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

function SettingsPanel(props: {
  settings: EngageSettings
  suggestions: PersonSuggestion[]
  stats: EngageStats | null
  engagersAt: string | null
  onDismiss: (profileId: string) => void
  onSave: (s: EngageSettings) => void
}) {
  const [watch, setWatch] = useState(props.settings.watchlist)
  const [topics, setTopics] = useState(props.settings.topics)
  const [min, setMin] = useState(props.settings.minReactions)
  const [industries, setIndustries] = useState(props.settings.industries ?? [])
  const [iq, setIq] = useState('')
  const [iResults, setIResults] = useState<{ id: string; title: string }[]>([])

  useEffect(() => {
    if (iq.trim().length < 2) {
      setIResults([])
      return
    }
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        setIResults(await searchIndustries(iq.trim(), ctl.signal))
      } catch {
        if (!ctl.signal.aborted) setIResults([])
      }
    }, 350)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [iq])
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
        <span className="field-label">Always in your circle · checked first, never dropped</span>
        <div className="en-chips">
          {watch.map((w) => {
            const sc = props.stats?.byPerson[w.profileId]
            const cold = !!sc && sc.measured >= 3 && sc.authorReplied + sc.authorLiked + sc.engagedBack === 0
            return (
            <span
              key={w.profileId}
              className={`en-chip ${cold ? 'cold' : ''}`}
              title={cold ? `${sc!.measured} comments, no reply, like or engagement back yet. Worth keeping?` : w.headline}
            >
              {w.name}
              {sc && <span className="en-chip-n">{sc.comments}</span>}
              <button onClick={() => setWatch(watch.filter((x) => x.profileId !== w.profileId))} aria-label={`Remove ${w.name}`}>
                ×
              </button>
            </span>
            )
          })}
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
        <span className="field-label">Your sector · popular posts from the last day by people in these industries (up to 5)</span>
        <div className="en-chips">
          {industries.map((i) => (
            <span key={i.id} className="en-chip">
              {i.title}
              <button onClick={() => setIndustries(industries.filter((x) => x.id !== i.id))} aria-label={`Remove ${i.title}`}>
                ×
              </button>
            </span>
          ))}
          {!industries.length && <span className="muted">None yet, e.g. Venture Capital, E-Learning</span>}
        </div>
        <input className="en-input" value={iq} onChange={(e) => setIq(e.target.value)} placeholder="Add an industry" disabled={industries.length >= 5} />
        {iResults.length > 0 && (
          <div className="mt-pop">
            {iResults.map((r) => (
              <button
                key={r.id}
                className="mt-row"
                onClick={() => {
                  if (!industries.some((x) => x.id === r.id) && industries.length < 5) setIndustries([...industries, r])
                  setIq('')
                }}
              >
                <span className="mt-name">{r.title}</span>
              </button>
            ))}
          </div>
        )}
        <label className="en-min">
          Only topic posts with at least
          <input type="number" min={0} max={5000} value={min} onChange={(e) => setMin(Math.max(0, Number(e.target.value) || 0))} />
          reactions
        </label>
      </div>
      <div className="en-sugg">
        <span className="field-label">
          Suggested people · from who engages with your posts and who keeps coming up in your topics
        </span>
        {!props.suggestions.filter((x) => !watch.some((w) => w.profileId === x.profileId)).length && (
          <span className="muted">
            {props.engagersAt
              ? 'No new suggestions right now.'
              : 'Reading who engages with your posts. Suggestions show up within the hour.'}
          </span>
        )}
        <div className="en-sugg-list">
          {props.suggestions
            .filter((x) => !watch.some((w) => w.profileId === x.profileId))
            .map((x) => (
              <div key={x.profileId} className="en-sugg-row">
                <Face c={{ author: x.name, picture: x.picture }} size={30} />
                <span className="mt-who">
                  <span className="mt-name">
                    {x.url ? (
                      <a className="link" href={x.url} target="_blank" rel="noreferrer">
                        {x.name}
                      </a>
                    ) : (
                      x.name
                    )}
                    <span className={`en-why ${x.why}`}>{x.why === 'engages-with-you' ? 'Engages with you' : 'In your topics'}</span>
                  </span>
                  {x.headline && <span className="mt-head">{x.headline}</span>}
                  <span className="mt-head">{x.reason}</span>
                </span>
                <button
                  className="btn ghost sm"
                  onClick={() => setWatch([...watch, { name: x.name, profileId: x.profileId, headline: x.headline, picture: x.picture, url: x.url }])}
                  disabled={watch.length >= 40}
                  title={watch.length >= 40 ? 'Watchlist is full (40)' : undefined}
                >
                  Follow
                </button>
                <button className="btn ghost sm" onClick={() => props.onDismiss(x.profileId)} aria-label={`Not interested in ${x.name}`}>
                  Not for me
                </button>
              </div>
            ))}
        </div>
      </div>
      <div className="en-save">
        <button className="btn primary sm" onClick={() => props.onSave({ ...props.settings, watchlist: watch, topics, minReactions: min, industries })}>
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
      await sendComment(p, body)
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

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–')

/** Small history badge on a feed post: how your past comments on this person went. */
function History(props: { s: Score }) {
  const { s } = props
  const back = s.authorReplied + s.authorLiked + s.engagedBack
  return (
    <span className={`en-hist ${back ? 'warm' : ''}`} title="Your past comments on this person">
      {s.comments}× before{back > 0 && ` · ${[s.authorReplied && `replied ${s.authorReplied}`, s.engagedBack && 'engaged back'].filter(Boolean).join(', ') || 'liked yours'}`}
    </span>
  )
}

/**
 * How your comments have landed, by watchlist vs each topic, and the people who engage back most.
 * Results come in from the cron over two weeks, so new comments show as "waiting".
 */
function WhatsWorking(props: { stats: EngageStats; settings: EngageSettings | null }) {
  const { stats } = props
  if (!stats.total)
    return (
      <div className="en-stats">
        <p className="muted">
          Nothing to show yet. Every comment you post from this tab is now tracked: likes on it, whether the author replies or
          likes it, and whether they later engage with your posts. Results start showing a couple of hours after your first
          comment.
        </p>
      </div>
    )
  const byTopic: [string, Score][] = Object.entries(stats.byTopic).sort((a, b) => b[1].comments - a[1].comments)
  const rows = ([['Watchlist', stats.watchlist], ['Your feed', stats.feed], ...byTopic] as [string, Score][]).filter(([, s]) => s.comments > 0)
  const people = Object.entries(stats.byPerson)
    .map(([id, s]) => ({ id, ...s, back: s.authorReplied + s.authorLiked + s.engagedBack }))
    .sort((a, b) => b.back - a.back || b.avgLikes - a.avgLikes)
  const warm = people.filter((p) => p.back > 0).slice(0, 8)
  const watched = new Set(props.settings?.watchlist.map((w) => w.profileId) ?? [])
  const cold = people.filter((p) => watched.has(p.id) && p.measured >= 3 && p.back === 0)
  return (
    <div className="en-stats">
      <table className="en-table">
        <thead>
          <tr>
            <th>Where from</th>
            <th>Comments</th>
            <th>Likes per comment</th>
            <th>Author replied</th>
            <th>Author liked it</th>
            <th>Engaged back</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, s]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>
                {s.comments}
                {s.measured < s.comments && <span className="muted"> ({s.comments - s.measured} waiting)</span>}
              </td>
              <td>{s.measured ? s.avgLikes : '–'}</td>
              <td>{pct(s.authorReplied, s.measured)}</td>
              <td>{pct(s.authorLiked, s.measured)}</td>
              <td>{pct(s.engagedBack, s.comments)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="en-stats-people">
        <div>
          <span className="field-label">Engage back most</span>
          {warm.length ? (
            warm.map((p) => (
              <div key={p.id} className="en-stats-person">
                <strong>{p.name}</strong>{' '}
                <span className="muted">
                  {p.comments} comments · replied {p.authorReplied} · liked {p.authorLiked}
                  {p.engagedBack > 0 && ' · engaged with your posts'}
                </span>
              </div>
            ))
          ) : (
            <span className="muted">Nobody yet</span>
          )}
        </div>
        {cold.length > 0 && (
          <div>
            <span className="field-label">On your watchlist, never engage back</span>
            {cold.map((p) => (
              <div key={p.id} className="en-stats-person">
                <strong>{p.name}</strong> <span className="muted">{p.measured} comments, nothing back</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const KIND = { posted: 'Posted by', liked: 'Liked by', commented: 'Commented on by' } as const

/** Why a circle post is in your feed: who posted, liked or commented on it. */
function ViaLine(props: { via: NonNullable<FeedPost['via']>; author?: string }) {
  const groups = (['posted', 'commented', 'liked'] as const)
    .map((k) => [k, props.via.filter((v) => v.kind === k && !(k !== 'posted' && v.id === props.author))] as const)
    .filter(([, vs]) => vs.length)
  if (!groups.length) return null
  return (
    <span className="en-via">
      {groups.map(([k, vs]) => `${KIND[k]} ${vs.map((v) => v.name.split(' ')[0]).slice(0, 3).join(', ')}${vs.length > 3 ? ` +${vs.length - 3}` : ''}`).join(' · ')}
    </span>
  )
}

const WHY = { watchlist: 'Always in', engager: 'Engages with you', message: 'You message', poster: 'Posts a lot' } as const

/** Who's in your circle and why. Remove anyone; they never come back. */
function CirclePanel(props: { circle: CircleInfo; onRemove: (id: string) => void }) {
  const [all, setAll] = useState(false)
  const [q, setQ] = useState('')
  const people = props.circle.people.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
  const shown = all || q.trim() ? people : people.slice(0, 40)
  return (
    <div className="en-circle">
      <div className="en-circle-head">
        <span className="field-label">
          Your circle · {props.circle.size} people. Rebuilt daily from who engages with you, who you message and who posts a lot. The
          app checks a couple of them every 15 minutes.
        </span>
        <input className="en-input sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone" />
      </div>
      <div className="en-chips">
        {shown.map((p) => (
          <span key={p.id} className="en-chip" title={[p.headline, p.why.map((w) => WHY[w]).join(', ')].filter(Boolean).join(' · ')}>
            {p.name}
            <span className="en-chip-n">{WHY[p.why[0]]}</span>
            {!p.why.includes('watchlist') && (
              <button onClick={() => props.onRemove(p.id)} aria-label={`Take ${p.name} out of your circle`}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      {!all && !q.trim() && people.length > shown.length && (
        <button className="link" onClick={() => setAll(true)}>
          Show all {people.length}
        </button>
      )}
    </div>
  )
}
