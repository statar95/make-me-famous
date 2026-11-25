import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMentions } from './Mentions'
import { Riff } from './Riff'
import { bestTime, bestTimes } from './bestTimes'
import {
  type AnalyticsPost,
  type Mention,
  type Post,
  type Profile,
  type Schedule,
  LIMITS,
  MAX_MEDIA,
  countFor,
  dayDropTime,
  dayLabel,
  mediaUrl,
  sameDay,
  slotTaken,
  timeLabel,
  toLocalInput,
  uid,
  uploadImage,
  useStore,
} from './store'
import { LinkedInComment, LinkedInPreview } from './Previews'
import { PostsBoard } from './Board'
import { CommentsView } from './Comments'
import { EngageView } from './Engage'
import { DRAG_TYPE, dragId, startDrag } from './drag'
import { AnalyticsView } from './Analytics'
import type { Phase } from './store'

type View = 'compose' | 'posts' | 'calendar' | 'replies' | 'comments' | 'results'

interface Toast {
  id: string
  msg: string
}

export default function App() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const toast = useCallback((msg: string) => {
    const id = uid()
    setToasts((t) => [...t, { id, msg }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200)
  }, [])
  const store = useStore(toast)
  const { posts, profile, phase } = store
  const [view, setView] = useState<View>('posts')
  const [editing, setEditing] = useState<Post | null>(null)
  const [waitingComments, setWaitingComments] = useState<number | undefined>(undefined)
  const [seedDate, setSeedDate] = useState<Date | null>(null)
  const publishing = useRef(new Set<string>())

  const publish = async (post: Post) => {
    if (publishing.current.has(post.id)) return
    if (!window.confirm('Post this to your real LinkedIn now?')) return
    publishing.current.add(post.id)
    try {
      await store.publish(post)
      toast('Posted to LinkedIn')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Publishing failed')
    } finally {
      publishing.current.delete(post.id)
    }
  }

  /** Drag and drop, slot pickers and calendar drops all end up here. */
  const scheduleAt = (id: string, at: number) => {
    const post = posts.find((p) => p.id === id)
    if (!post || !['draft', 'scheduled'].includes(post.status)) return
    if (at <= Date.now()) return toast("That time's already gone")
    if (slotTaken(posts, at, id)) return toast("That slot's taken. Move the other one first.")
    store.patch(id, { status: 'scheduled', scheduledAt: new Date(at).toISOString(), platforms: ['linkedin'] })
    toast(`Scheduled for ${dayLabel(new Date(at))} at ${timeLabel(new Date(at).toISOString())}`)
  }

  const unschedule = (id: string) => {
    const post = posts.find((p) => p.id === id)
    if (post?.status !== 'scheduled') return
    store.patch(id, { status: 'draft', scheduledAt: null })
    toast('Back in the backlog')
  }

  const openCompose = (post: Post | null, date: Date | null = null) => {
    setEditing(post)
    setSeedDate(date)
    setView('compose')
  }

  const counts = {
    posts: posts.filter((p) => p.status !== 'posted').length,
  }

  const toastLayer = (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.msg}
        </div>
      ))}
    </div>
  )

  if (phase !== 'ready')
    return (
      <>
        <Gate phase={phase} onLogin={store.login} onRetry={store.refresh} />
        {toastLayer}
      </>
    )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <span className="brand-text">
            Make Me Famous
            <small>a post scheduler, technically</small>
          </span>
        </div>
        <button className="btn primary block" onClick={() => openCompose(null)}>
          + New post
        </button>
        <nav>
          <NavItem label="Posts" active={view === 'posts'} count={counts.posts} onClick={() => setView('posts')} />
          <NavItem label="Calendar" active={view === 'calendar'} onClick={() => setView('calendar')} />
          <NavItem
            label="Replies"
            active={view === 'replies'}
            count={waitingComments}
            onClick={() => setView('replies')}
          />
          <NavItem label="Comments" active={view === 'comments'} onClick={() => setView('comments')} />
          <NavItem label="Results" active={view === 'results'} onClick={() => setView('results')} />
        </nav>
        <span className="spacer" />
        <ProfileCard profile={profile} onChange={store.setProfile} />
        <div className="stub-badge" title="Scheduled posts and Publish now go to your real LinkedIn.">
          <span className="dot" /> Live: LinkedIn posts are real
        </div>
        <button className="link signout" onClick={store.logout}>
          Sign out
        </button>
      </aside>

      <main className="main">
        {view === 'compose' && (
          <Composer
            key={editing?.id ?? `new-${seedDate?.getTime() ?? ''}`}
            initial={editing}
            seedDate={seedDate}
            profile={profile}
            onSave={(post, msg) => {
              store.upsert(post)
              toast(msg)
              setView('posts')
            }}
            onAutosave={(post) => store.upsert(post)}
            history={store.analytics?.posts ?? []}
            otherScheduled={posts
              .filter((p) => p.id !== editing?.id && (p.status === 'scheduled' || p.status === 'posted'))
              .map((p) => p.scheduledAt ?? p.postedAt)
              .filter((x): x is string => !!x)}
            onPublish={(post) => {
              publish(post)
              setView('results')
            }}
            onDelete={(id) => {
              store.remove(id)
              toast('Deleted')
              setView('posts')
            }}
            onCancel={() => setView('posts')}
          />
        )}
        {view === 'posts' && (
          <PostsBoard
            posts={posts}
            onEdit={(p) => openCompose(p)}
            onNew={() => openCompose(null)}
            onSetReady={(p, ready) => {
              store.patch(p.id, { ready })
              toast(ready ? 'Ready. Drop it on the Calendar when you know when.' : 'Back in ideas')
            }}
            onUnschedule={(p) => unschedule(p.id)}
          />
        )}
        {view === 'calendar' && (
          <CalendarView
            posts={posts}
            schedule={store.schedule}
            onEdit={(p) => openCompose(p)}
            onNewAt={(d) => openCompose(null, d)}
            onDropAt={scheduleAt}
            history={store.analytics?.posts ?? []}
          />
        )}
        {view === 'replies' && <CommentsView posts={posts} toast={toast} onCount={setWaitingComments} />}
        {view === 'comments' && <EngageView toast={toast} />}
        {view === 'results' && <AnalyticsView analytics={store.analytics} onLoad={store.loadAnalytics} />}
        {view === 'results' && (
          <HistoryView
            posts={posts}
            onReuse={(p) => {
              const now = new Date().toISOString()
              const copy: Post = {
                ...p,
                id: uid(),
                status: 'draft',
                scheduledAt: null,
                postedAt: null,
                results: undefined,
                comment: undefined,
                ready: undefined,
                createdAt: now,
                updatedAt: now,
              }
              store.upsert(copy)
              openCompose(copy)
              toast('Copied to a new draft')
            }}
            onDelete={(id) => {
              store.remove(id)
              toast('Removed from history')
            }}
            onRetryComment={async (p) => {
              if (!window.confirm('Post the first comment on LinkedIn now?')) return
              try {
                await store.retryComment(p.id)
                toast('Comment posted')
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Comment failed again')
              }
            }}
          />
        )}
      </main>

      {toastLayer}
    </div>
  )
}

// ---------------------------------------------------------------- Sidebar bits

/** A speech bubble with a hopeful little smile. */
function Mark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="mark">
      <path d="M4 7a5 5 0 0 1 5-5h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-9l-6 6v-6H9a5 5 0 0 1-5-5z" fill="var(--sun)" />
      <circle cx="11.5" cy="10.5" r="1.7" fill="var(--paper)" />
      <circle cx="20.5" cy="10.5" r="1.7" fill="var(--paper)" />
      <path d="M10.5 15c1.4 1.8 3.3 2.6 5.5 2.6s4.1-.8 5.5-2.6" stroke="var(--paper)" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function Gate(props: { phase: Phase; onLogin: (pw: string) => Promise<boolean>; onRetry: () => void }) {
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState(false)
  return (
    <div className="gate">
      <div className="gate-card">
        <Mark size={44} />
        <h1>Make Me Famous</h1>
        {props.phase === 'loading' && <p className="muted">Warming up the charm…</p>}
        {props.phase === 'error' && (
          <>
            <p className="muted">Couldn't reach the server.</p>
            <button className="btn primary" onClick={props.onRetry}>
              Try again
            </button>
          </>
        )}
        {props.phase === 'locked' && (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              const ok = await props.onLogin(pw)
              setBusy(false)
              setWrong(!ok)
            }}
          >
            <p className="muted">Private. These drafts aren't ready to be liked yet.</p>
            <input
              type="password"
              autoFocus
              placeholder="Password"
              value={pw}
              onChange={(e) => {
                setPw(e.target.value)
                setWrong(false)
              }}
              className={wrong ? 'wrong' : ''}
            />
            {wrong && <p className="gate-wrong">Not quite.</p>}
            <button className="btn primary block" disabled={!pw || busy}>
              {busy ? 'Checking…' : 'Come in'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

function NavItem(props: { label: string; active: boolean; count?: number; onClick: () => void }) {
  return (
    <button className={`nav ${props.active ? 'active' : ''}`} onClick={props.onClick}>
      <span>{props.label}</span>
      {props.count ? <span className="nav-count">{props.count}</span> : null}
    </button>
  )
}

function ProfileCard({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(profile)
  if (!open)
    return (
      <button
        className="profile"
        onClick={() => {
          setDraft(profile)
          setOpen(true)
        }}
        title="Edit how you appear in previews"
      >
        <span className="avatar sm">{profile.name.slice(0, 1)}</span>
        <span className="profile-text">
          <strong>{profile.name}</strong>
          <small>{profile.headline}</small>
        </span>
      </button>
    )
  return (
    <div className="profile-edit">
      <label>
        Name
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label>
        LinkedIn headline
        <input value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} />
      </label>
      <div className="row">
        <button className="btn ghost sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          className="btn primary sm"
          onClick={() => {
            onChange(draft)
            setOpen(false)
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Composer


const dayChip = (d: Date) => {
  const today = new Date()
  if (sameDay(d, today)) return 'Today'
  if (sameDay(d, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1))) return 'Tomorrow'
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
}

function Composer(props: {
  initial: Post | null
  seedDate: Date | null
  profile: Profile
  onSave: (p: Post, msg: string) => void
  /** Quiet save while you type: no toast, stays on the page. */
  onAutosave: (p: Post) => Promise<unknown> | void
  /** Your past LinkedIn posts, for suggesting posting times. */
  history: AnalyticsPost[]
  /** When your other posts go (or went) out, to keep them spaced apart. */
  otherScheduled: string[]
  onPublish: (p: Post) => void
  onDelete: (id: string) => void
  onCancel: () => void
}) {
  const { initial } = props
  const [text, setText] = useState(initial?.text ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [notes] = useState(initial?.notes ?? '')
  const [firstComment, setFirstComment] = useState(initial?.firstComment ?? '')
  const [showComment, setShowComment] = useState(!!initial?.firstComment)
  const [media, setMedia] = useState<string[]>(initial?.media ?? [])
  const [mentions, setMentions] = useState<Mention[]>(initial?.mentions ?? [])
  const [ready, setReady] = useState(!!initial?.ready)
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState('')
  const [when, setWhen] = useState(() => {
    if (initial?.scheduledAt) return toLocalInput(new Date(initial.scheduledAt))
    if (props.seedDate) return toLocalInput(props.seedDate)
    return ''
  })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [previewing, setPreviewing] = useState<{ label: string; text: string } | null>(null)
  const [undo, setUndo] = useState<{ text: string; comment: string } | null>(null)
  const tags = useMentions({ text, setText, textarea: ta, mentions, setMentions, comment: firstComment })
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ta.current?.focus()
  }, [])

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const room = MAX_MEDIA - media.length - uploading
    const picked = [...files].slice(0, Math.max(0, room))
    setUploadError(files.length > picked.length ? `LinkedIn stops at ${MAX_MEDIA} images.` : '')
    setUploading((n) => n + picked.length)
    // One request per image keeps each under the function body limit.
    for (const f of picked) {
      try {
        const path = await uploadImage(f)
        setMedia((m) => (m.length < MAX_MEDIA ? [...m, path] : m))
      } catch (e) {
        setUploadError(`${f.name}: ${e instanceof Error ? e.message : 'upload failed'}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const move = (i: number, by: number) =>
    setMedia((m) => {
      const j = i + by
      if (j < 0 || j >= m.length) return m
      const next = [...m]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const whenDate = when ? new Date(when) : null
  const liOver = countFor('linkedin', text) > LIMITS.linkedin
  const problems: string[] = []
  if (!text.trim()) problems.push('Write something first')
  if (liOver) problems.push('Over LinkedIn’s 3,000 character limit')
  if (firstComment.length > 1250) problems.push('First comment is over 1,250 characters')
  if (uploading) problems.push('Still uploading')
  const scheduleProblem = !whenDate
    ? 'Pick a date and time'
    : whenDate.getTime() <= Date.now()
      ? 'That time is in the past'
      : null

  // Autosave: a second after you stop typing, save as a draft (a scheduled post stays scheduled
  // at its time; the When box only applies when you press Schedule).
  const [postId] = useState(() => initial?.id ?? uid())
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const content = JSON.stringify([text, title, firstComment, media, tags.live, ready])
  const lastSaved = useRef(content)
  useEffect(() => {
    if (content === lastSaved.current) return
    if (!initial && !text.trim()) return
    if (uploading) return
    const t = setTimeout(async () => {
      setSaveState('saving')
      const keepScheduled = initial?.status === 'scheduled' && initial.scheduledAt
      try {
        await props.onAutosave(
          build(keepScheduled ? { status: 'scheduled', scheduledAt: initial.scheduledAt } : {}),
        )
        lastSaved.current = content
        setSaveState('saved')
      } catch {
        setSaveState('error')
      }
    }, 1200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, uploading])

  const build = (changes: Partial<Post>): Post => {
    const now = new Date().toISOString()
    return {
      id: postId,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
      postedAt: null,
      text,
      title: title.trim() || undefined,
      notes: notes.trim() || undefined,
      firstComment: firstComment.trim() || undefined,
      media: media.length ? media : undefined,
      mentions: tags.live.length ? tags.live : undefined,
      ready: ready || undefined,
      platforms: ['linkedin'],
      status: 'draft',
      scheduledAt: null,
      ...changes,
    }
  }

  const schedule = () => {
    if (problems.length || scheduleProblem) return
    props.onSave(
      build({ status: 'scheduled', scheduledAt: whenDate!.toISOString() }),
      `Scheduled for ${dayLabel(whenDate!)} at ${timeLabel(whenDate!.toISOString())}`,
    )
  }

  // Posting-time suggestions for the day in the When box, or the day you pick.
  const [pickedDay, setPickedDay] = useState<Date | null>(null)
  const days = useMemo(() => {
    const out: Date[] = []
    const d = new Date()
    for (let i = 0; i < 8; i++) out.push(new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, 12))
    return out
  }, [])
  const slotDay = pickedDay ?? (whenDate ? new Date(whenDate.getFullYear(), whenDate.getMonth(), whenDate.getDate(), 12) : days[1])
  const best = useMemo(() => bestTimes(slotDay, props.history), [slotDay.getTime(), props.history])
  const top = best.length ? best.reduce((a, b) => (b.score > a.score ? b : a)) : null
  const clash = (() => {
    if (!whenDate) return null
    const near = props.otherScheduled
      .map((x) => new Date(x))
      .filter((x) => Math.abs(x.getTime() - whenDate.getTime()) < 3 * 86_400_000)
      .sort((a, b) => Math.abs(a.getTime() - whenDate.getTime()) - Math.abs(b.getTime() - whenDate.getTime()))[0]
    return near ? `Another post goes out ${dayLabel(near)} at ${timeLabel(near.toISOString())}. Keep 3+ days between posts.` : null
  })()

  const hint = [...problems, when ? scheduleProblem : null].filter(Boolean).join(' · ')

  return (
    <div className="composer">
      <section className="compose-pane">
        <header className="page-head">
          <h1>{initial ? (initial.status === 'scheduled' ? 'Edit scheduled post' : 'Edit draft') : 'New post'}</h1>
          {(!initial || initial.status === 'draft') && (
            <button className={`btn sm ${ready ? 'ready-on' : 'ghost'}`} onClick={() => setReady(!ready)}>
              {ready ? '✓ Ready' : 'Mark ready'}
            </button>
          )}
          <span className={`autosave ${saveState}`}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Couldn’t save' : ''}
          </span>
          <button className="btn ghost sm" onClick={props.onCancel}>
            Close
          </button>
        </header>

        <input
          className="title-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Working title or angle (just for you)"
        />

        <div className="editor">
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              requestAnimationFrame(tags.check)
            }}
            onSelect={tags.check}
            placeholder="What do you want to say? Type @ to tag someone"
            onKeyDown={(e) => {
              if (tags.onKeyDown(e)) return
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') schedule()
            }}
          />
          <div className="editor-foot">
            <span className={`count ${liOver ? 'over' : ''}`}>
              LinkedIn {countFor('linkedin', text).toLocaleString()}/{LIMITS.linkedin.toLocaleString()}
            </span>
            <span className="count muted">{text.trim() ? text.trim().split(/\s+/).length : 0} words</span>
          </div>
        </div>
        {tags.dropdown}
        <Riff
          text={text}
          firstComment={firstComment}
          canUndo={!!undo}
          onPreview={setPreviewing}
          previewText={previewing?.text}
          onApply={(t, c) => {
            setUndo({ text, comment: firstComment })
            if (t !== null) setText(t)
            if (c !== null) {
              setFirstComment(c)
              setShowComment(true)
            }
          }}
          onUndo={() => {
            if (!undo) return
            setText(undo.text)
            setFirstComment(undo.comment)
            setUndo(null)
          }}
        />
        <div className="notes">
          {showComment ? (
            <>
              <label className="field-label" htmlFor="first-comment">
                First comment <span className="muted">· posted right after, where the link goes</span>
              </label>
              <textarea
                id="first-comment"
                value={firstComment}
                onChange={(e) => setFirstComment(e.target.value)}
                placeholder="Link in the comments, as is the custom."
              />
              <span className={`count ${firstComment.length > 1250 ? 'over' : 'muted'}`}>{firstComment.length}/1,250</span>
            </>
          ) : (
            <button className="link" onClick={() => setShowComment(true)}>
              + Add a first comment
            </button>
          )}
        </div>

        {tags.panel}

        <div className="media-field">
          <div className="media-strip">
            {media.map((m, i) => (
              <figure key={m} className="thumb">
                <img src={mediaUrl(m)} alt={`Image ${i + 1}`} />
                <figcaption>
                  <button className="thumb-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move image ${i + 1} earlier`}>
                    ←
                  </button>
                  <button className="thumb-btn" onClick={() => setMedia((x) => x.filter((p) => p !== m))} aria-label={`Remove image ${i + 1}`}>
                    ×
                  </button>
                  <button
                    className="thumb-btn"
                    onClick={() => move(i, 1)}
                    disabled={i === media.length - 1}
                    aria-label={`Move image ${i + 1} later`}
                  >
                    →
                  </button>
                </figcaption>
              </figure>
            ))}
            {Array.from({ length: uploading }, (_, i) => (
              <div key={`up-${i}`} className="thumb loading">
                Squashing…
              </div>
            ))}
            {media.length + uploading < MAX_MEDIA && (
              <button className="thumb add" onClick={() => fileInput.current?.click()}>
                + Photo
                <small>
                  {media.length}/{MAX_MEDIA}
                </small>
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          {uploadError && <p className="form-hint">{uploadError}</p>}
        </div>

        <div className="schedule">
          <label className="field-label" htmlFor="when">
            When
          </label>
          <div className="schedule-row">
            <input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            {when && (
              <button className="btn ghost sm" onClick={() => setWhen('')}>
                Clear
              </button>
            )}
          </div>
          <div className="days">
            {days.map((d) => (
              <button
                key={d.getTime()}
                className={`slot ${sameDay(d, slotDay) ? 'on' : ''}`}
                onClick={() => setPickedDay(d)}
              >
                {dayChip(d)}
              </button>
            ))}
          </div>
          <div className="best-label">Best times on {dayLabel(slotDay)}</div>
          <div className="slots">
            {best.map((b) => (
              <button
                key={b.at.getTime()}
                className={`slot best ${when === toLocalInput(b.at) ? 'on' : ''}`}
                title={b.why}
                onClick={() => setWhen(toLocalInput(b.at))}
              >
                {timeLabel(b.at.toISOString())}
                {b === top && <span className="best-star"> ★ best</span>}
                <span className="best-why">{b.why}</span>
              </button>
            ))}
            {!best.length && <span className="muted">No good times left that day.</span>}
          </div>
          {clash && <p className="form-hint">{clash}</p>}
        </div>

        <div className="compose-actions">
          {initial && (
            <button
              className={`btn danger-ghost ${confirmDelete ? 'armed' : ''}`}
              onClick={() => (confirmDelete ? props.onDelete(initial.id) : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
            >
              {confirmDelete ? 'Click again to delete' : 'Delete'}
            </button>
          )}
          <span className="spacer" />
          <button
            className="btn ghost"
            disabled={!text.trim() || uploading > 0}
            onClick={() => props.onSave(build({ status: 'draft' }), 'Draft saved')}
          >
            Save draft
          </button>
          <button className="btn ghost" disabled={problems.length > 0} onClick={() => props.onPublish(build({}))}>
            Publish now
          </button>
          <button
            className="btn primary"
            disabled={problems.length > 0 || !!scheduleProblem}
            onClick={schedule}
            title={hint || '⌘↩ to schedule'}
          >
            Schedule
          </button>
        </div>
        {hint && text.trim() && <p className="form-hint">{hint}</p>}
      </section>

      <section className="preview-pane">
        <div className="preview-label">{previewing ? 'Claude’s suggested changes' : 'Live preview'}</div>
        {previewing && (
          <div className="diff-banner">
            <span>
              <strong>{previewing.label}</strong>
              <span className="diff-legend">
                <del className="chg-del">removed</del>
                <ins className="chg-add">added</ins>
              </span>
            </span>
            <button className="btn ghost sm" onClick={() => setPreviewing(null)}>
              Back to my post
            </button>
          </div>
        )}
        <LinkedInPreview
          text={text}
          profile={props.profile}
          media={media}
          tags={mentions.map((m) => m.name)}
          compareTo={previewing?.text}
        />
        {firstComment.trim() && (
          <div>
            <span className="field-label">First comment</span>
            <LinkedInComment text={firstComment} profile={props.profile} tags={mentions.map((m) => m.name)} />
          </div>
        )}
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- Calendar

function CalendarView(props: {
  posts: Post[]
  schedule: Schedule
  onEdit: (p: Post) => void
  onNewAt: (d: Date) => void
  onDropAt: (id: string, at: number) => void
  /** Your past posts, so a drop lands on that day's best time. */
  history: AnalyticsPost[]
}) {
  const [over, setOver] = useState<string | null>(null)
  const [cursor, setCursor] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const today = new Date()
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  // Monday-first grid covering the month.
  const start = new Date(cursor)
  start.setDate(1 - ((cursor.getDay() + 6) % 7))
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
  const grid = days[35].getMonth() !== cursor.getMonth() ? days.slice(0, 35) : days

  const dated = props.posts
    .map((p) => ({ p, at: p.status === 'posted' ? p.postedAt : p.scheduledAt }))
    .filter((x): x is { p: Post; at: string } => !!x.at)

  // Ready posts first: they're the ones waiting for a day.
  const drafts = props.posts
    .filter((p) => p.status === 'draft')
    .sort((a, b) => Number(!!b.ready) - Number(!!a.ready) || b.updatedAt.localeCompare(a.updatedAt))

  const shift = (n: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1))

  const newAt = (d: Date) => {
    const at = new Date(d)
    at.setHours(9, 0, 0, 0)
    if (at.getTime() <= Date.now()) {
      // Today and already past 9: suggest the next whole hour.
      at.setTime(Date.now() + 3600_000)
      at.setMinutes(0, 0, 0)
    }
    props.onNewAt(at)
  }

  return (
    <div className="page wide">
      <header className="page-head">
        <h1>{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1>
        <div className="row">
          <button className="btn ghost sm" onClick={() => shift(-1)} aria-label="Previous month">
            ←
          </button>
          <button className="btn ghost sm" onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}>
            Today
          </button>
          <button className="btn ghost sm" onClick={() => shift(1)} aria-label="Next month">
            →
          </button>
        </div>
      </header>
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="cal-dow">
            {d}
          </div>
        ))}
        {grid.map((d) => {
          const items = dated.filter((x) => sameDay(new Date(x.at), d)).sort((a, b) => a.at.localeCompare(b.at))
          const past = d < startOfToday
          const key = d.toISOString()
          return (
            <div
              key={key}
              className={`cal-cell ${d.getMonth() !== cursor.getMonth() ? 'out' : ''} ${sameDay(d, today) ? 'today' : ''} ${past ? 'past' : ''} ${over === key ? 'drop-over' : ''}`}
              onClick={() => !past && newAt(d)}
              onDragOver={(e) => {
                if (past || !e.dataTransfer.types.includes(DRAG_TYPE)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setOver(key)
              }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                const id = dragId(e)
                if (id) props.onDropAt(id, (bestTime(d, props.history) ?? new Date(dayDropTime(props.schedule, d))).getTime())
              }}
            >
              <span className="cal-num">{d.getDate()}</span>
              <div className="cal-items">
                {items.map(({ p, at }) => (
                  <button
                    key={p.id}
                    className={`cal-chip ${p.status}`}
                    draggable={p.status === 'scheduled'}
                    onDragStart={(e) => startDrag(e, p.id)}
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onEdit(p)
                    }}
                    title={p.text}
                  >
                    <span className="cal-time">{timeLabel(at)}</span>
                    <span className="cal-snip">{p.text.split('\n')[0]}</span>
                  </button>
                ))}
              </div>
              {!past && <span className="cal-add">+</span>}
            </div>
          )
        })}
      </div>
      <div className="legend">
        <span>
          <i className="lg scheduled" /> Scheduled
        </span>
        <span>
          <i className="lg posted" /> Posted
        </span>
        <span className="muted">Click a day to schedule something for it, or drag a post onto one.</span>
      </div>
      {drafts.length > 0 && (
        <div className="cal-tray">
          <span className="field-label">Drag onto a day · it lands on that day's best time</span>
          <div className="cal-tray-items">
            {drafts.map((p) => (
              <button
                key={p.id}
                className={`cal-chip draft ${p.ready ? 'ready' : ''}`}
                draggable
                onDragStart={(e) => startDrag(e, p.id)}
                onClick={() => props.onEdit(p)}
                title={p.text}
              >
                <span className="cal-snip">
                  {p.ready && '✓ '}
                  {p.title || p.text.split('\n')[0] || 'Empty draft'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- History

function HistoryView(props: {
  posts: Post[]
  onReuse: (p: Post) => void
  onDelete: (id: string) => void
  onRetryComment: (p: Post) => Promise<void>
}) {
  const [retrying, setRetrying] = useState<string | null>(null)
  const posted = props.posts
    .filter((p) => p.status === 'posted')
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>History</h1>
          <p className="muted">Everything you've said in public.</p>
        </div>
      </header>
      {posted.length === 0 && (
        <div className="empty">
          <p>Nothing published yet. Mysterious.</p>
        </div>
      )}
      {posted.map((p) => (
        <article key={p.id} className="card posted">
          <div className="card-meta">
            <span className="time">
              {new Date(p.postedAt!).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ·{' '}
              {timeLabel(p.postedAt!)}
            </span>
            <span className="badge linkedin">LinkedIn</span>
            <span className="pill ok">Posted</span>
          </div>
          <p className="card-text full">{p.text}</p>
          {!!p.media?.length && (
            <div className="media-strip small">
              {p.media.map((m) => (
                <img key={m} src={mediaUrl(m)} alt="" className="thumb-img" />
              ))}
            </div>
          )}
          {p.firstComment && (
            <div className={`comment-status ${p.comment?.status ?? 'none'}`}>
              <span className="field-label">First comment</span>
              <p>{p.firstComment}</p>
              <p className="muted">
                {p.comment?.status === 'posted' && 'Posted underneath.'}
                {p.comment?.status === 'sending' && 'Sending…'}
                {p.comment?.status === 'failed' && `Didn't go out: ${p.comment.error ?? 'unknown error'}. The post itself is fine.`}
                {!p.comment && 'Never sent.'}
              </p>
              {(p.comment?.status === 'failed' || !p.comment) && (
                <button
                  className="btn ghost sm"
                  disabled={retrying === p.id}
                  onClick={async () => {
                    setRetrying(p.id)
                    await props.onRetryComment(p)
                    setRetrying(null)
                  }}
                >
                  {retrying === p.id ? 'Retrying…' : 'Retry comment'}
                </button>
              )}
            </div>
          )}
          <div className="card-actions">
            <span className="muted mono">{p.results?.map((r) => r.id).join('  ')}</span>
            <span className="spacer" />
            <button className="link" onClick={() => props.onReuse(p)}>
              Reuse as draft
            </button>
            <button className="link danger" onClick={() => props.onDelete(p.id)}>
              Remove
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}
