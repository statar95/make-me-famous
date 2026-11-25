import { type DragEvent, useState } from 'react'
import { DRAG_TYPE, dragId, startDrag } from './drag'
import { type Post, dayLabel, timeLabel } from './store'

type Column = 'ideas' | 'ready' | 'scheduled'

const columnOf = (p: Post): Column | null =>
  p.status === 'scheduled' ? 'scheduled' : p.status === 'draft' ? (p.ready ? 'ready' : 'ideas') : null

const preview = (p: Post) => (p.text || '').split('\n').find((l) => l.trim()) ?? ''

/**
 * Posts as a board: Ideas (rough), Ready (finished, needs a time), Scheduled (going out).
 * Drag between Ideas and Ready, or use the buttons. Scheduling happens in the editor or on the Calendar.
 */
export function PostsBoard(props: {
  posts: Post[]
  onEdit: (p: Post) => void
  onNew: () => void
  onSetReady: (p: Post, ready: boolean) => void
  onUnschedule: (p: Post) => void
}) {
  const by = (c: Column) => props.posts.filter((p) => columnOf(p) === c)
  const ideas = by('ideas').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const ready = by('ready').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const scheduled = by('scheduled').sort((a, b) => (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''))
  const attention = props.posts.filter((p) => p.status === 'failed' || p.status === 'publishing')

  return (
    <div className="board-page">
      <header className="page-head">
        <h1>Posts</h1>
        <p className="muted">
          {scheduled.length
            ? `Next out ${dayLabel(new Date(scheduled[0].scheduledAt!))} at ${timeLabel(scheduled[0].scheduledAt!)}.`
            : 'Nothing scheduled yet.'}{' '}
          Drag ideas to Ready when they're done, then drop them on the Calendar.
        </p>
      </header>

      {attention.length > 0 && (
        <div className="board-attention">
          <span className="field-label">Needs a look</span>
          {attention.map((p) => (
            <Card key={p.id} post={p} onEdit={() => props.onEdit(p)} />
          ))}
        </div>
      )}

      <div className="board">
        <Lane
          title="Ideas"
          hint="Rough drafts and things Claude added"
          posts={ideas}
          onDropPost={(id) => {
            const p = props.posts.find((x) => x.id === id)
            if (p && columnOf(p) === 'ready') props.onSetReady(p, false)
          }}
          onEdit={props.onEdit}
          action={(p) => ({ label: 'Mark ready →', run: () => props.onSetReady(p, true) })}
          footer={
            <button className="link" onClick={props.onNew}>
              + New idea
            </button>
          }
        />
        <Lane
          title="Ready"
          hint="Finished. Drop on the Calendar to schedule"
          posts={ready}
          onDropPost={(id) => {
            const p = props.posts.find((x) => x.id === id)
            if (p && columnOf(p) === 'ideas') props.onSetReady(p, true)
          }}
          onEdit={props.onEdit}
          action={(p) => ({ label: '← Back to ideas', run: () => props.onSetReady(p, false) })}
        />
        <Lane
          title="Scheduled"
          hint="Going out, soonest first"
          posts={scheduled}
          onEdit={props.onEdit}
          action={(p) => ({ label: 'Unschedule', run: () => props.onUnschedule(p) })}
          showTime
        />
      </div>
    </div>
  )
}

function Lane(props: {
  title: string
  hint: string
  posts: Post[]
  onEdit: (p: Post) => void
  onDropPost?: (id: string) => void
  action: (p: Post) => { label: string; run: () => void }
  footer?: React.ReactNode
  showTime?: boolean
}) {
  const [over, setOver] = useState(false)
  const drop = props.onDropPost
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
          e.preventDefault()
          setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault()
          setOver(false)
          const id = dragId(e)
          if (id) props.onDropPost?.(id)
        },
      }
    : {}
  return (
    <section className={`lane ${over ? 'over' : ''}`} {...drop}>
      <div className="lane-head">
        <span className="lane-title">
          {props.title} <span className="lane-count">{props.posts.length}</span>
        </span>
        <span className="lane-hint">{props.hint}</span>
      </div>
      <div className="lane-cards">
        {props.posts.map((p) => {
          const a = props.action(p)
          return (
            <Card key={p.id} post={p} onEdit={() => props.onEdit(p)} showTime={props.showTime}>
              <button className="link" onClick={a.run}>
                {a.label}
              </button>
            </Card>
          )
        })}
        {!props.posts.length && <div className="lane-empty">Nothing here</div>}
      </div>
      {props.footer}
    </section>
  )
}

function Card(props: { post: Post; onEdit: () => void; showTime?: boolean; children?: React.ReactNode }) {
  const p = props.post
  return (
    <article
      className={`bcard ${p.status}`}
      draggable={p.status === 'draft'}
      onDragStart={(e) => startDrag(e, p.id)}
      onClick={props.onEdit}
    >
      {(props.showTime || p.status !== 'draft') && p.scheduledAt && (
        <div className="bcard-time">
          {dayLabel(new Date(p.scheduledAt))} · {timeLabel(p.scheduledAt)}
        </div>
      )}
      {p.status === 'failed' && <div className="bcard-error">{p.error ?? 'Failed'}</div>}
      <div className="bcard-title">{p.title || preview(p) || 'Empty draft'}</div>
      {p.title && <div className="bcard-preview">{preview(p)}</div>}
      <div className="bcard-foot" onClick={(e) => e.stopPropagation()}>
        <span className="bcard-pills">
          {!!p.media?.length && <span>📷 {p.media.length}</span>}
          {!!p.mentions?.length && <span>@ {p.mentions.length}</span>}
          {p.firstComment && <span>💬</span>}
        </span>
        {props.children}
      </div>
    </article>
  )
}
