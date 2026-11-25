import { useEffect, useState } from 'react'
import type { Analytics, AnalyticsPost } from './store'

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
const engagement = (p: AnalyticsPost) => p.reactions + p.comments + p.reposts
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const weekday = (p: AnalyticsPost) => (new Date(p.date).getDay() + 6) % 7

function Summary({ label, posts }: { label: string; posts: AnalyticsPost[] }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{posts.length}</td>
      <td>{fmt(median(posts.map((p) => p.reactions)))}</td>
      <td>{fmt(median(posts.map((p) => p.comments)))}</td>
      <td>{fmt(median(posts.map((p) => p.reposts)))}</td>
      <td>{fmt(median(posts.map(engagement)))}</td>
    </tr>
  )
}

export function AnalyticsView(props: { analytics: Analytics | null; onLoad: () => Promise<void> }) {
  const [sort, setSort] = useState<{ key: 'date' | 'reactions'; desc: boolean }>({ key: 'date', desc: true })
  const { onLoad } = props
  useEffect(() => {
    onLoad()
  }, [onLoad])

  const a = props.analytics
  const posts = (a?.posts ?? []).filter((p) => !Number.isNaN(Date.parse(p.date)))
  const rows = [...posts].sort((x, y) => {
    const d = sort.key === 'date' ? Date.parse(x.date) - Date.parse(y.date) : x.reactions - y.reactions
    return sort.desc ? -d : d
  })
  const toggle = (key: 'date' | 'reactions') => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))
  const arrow = (key: 'date' | 'reactions') => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '')
  const ariaSort = (key: 'date' | 'reactions') => (sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none')

  return (
    <div className="page wide">
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="muted">
            {a?.fetchedAt
              ? `From LinkedIn, ${new Date(a.fetchedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. Refreshes at most every 6 hours.`
              : 'Asking LinkedIn how loved you are…'}
          </p>
        </div>
      </header>
      {a?.error && <p className="form-hint">Last refresh failed: {a.error}</p>}

      {posts.length === 0 ? (
        <div className="empty">
          <p>{a?.fetchedAt ? 'No posts found. A blank canvas.' : 'Nothing yet.'}</p>
        </div>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <span className="stat-num">{posts.length}</span>
              <span className="muted">posts</span>
            </div>
            <div className="stat">
              <span className="stat-num">{fmt(median(posts.map((p) => p.reactions)))}</span>
              <span className="muted">median reactions</span>
            </div>
            <div className="stat">
              <span className="stat-num">{fmt(median(posts.map((p) => p.comments)))}</span>
              <span className="muted">median comments</span>
            </div>
            <div className="stat">
              <span className="stat-num">{fmt(median(posts.map((p) => p.reposts)))}</span>
              <span className="muted">median reposts</span>
            </div>
          </div>

          <div className="compare">
            <div className="table-wrap">
              <table className="table">
                <caption>Photos or not (medians)</caption>
                <thead>
                  <tr>
                    <th />
                    <th>Posts</th>
                    <th>Reactions</th>
                    <th>Comments</th>
                    <th>Reposts</th>
                    <th>All</th>
                  </tr>
                </thead>
                <tbody>
                  <Summary label="With media" posts={posts.filter((p) => p.hasMedia)} />
                  <Summary label="Text only" posts={posts.filter((p) => !p.hasMedia)} />
                </tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table className="table">
                <caption>By weekday (medians)</caption>
                <thead>
                  <tr>
                    <th />
                    <th>Posts</th>
                    <th>Reactions</th>
                    <th>Comments</th>
                    <th>Reposts</th>
                    <th>All</th>
                  </tr>
                </thead>
                <tbody>
                  {DAYS.map((d, i) => {
                    const on = posts.filter((p) => weekday(p) === i)
                    return on.length ? <Summary key={d} label={d} posts={on} /> : null
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="table-wrap">
            <table className="table posts-table">
              <thead>
                <tr>
                  <th aria-sort={ariaSort('date')}>
                    <button className="link" onClick={() => toggle('date')}>
                      Date{arrow('date')}
                    </button>
                  </th>
                  <th>Post</th>
                  <th aria-sort={ariaSort('reactions')}>
                    <button className="link" onClick={() => toggle('reactions')}>
                      Reactions{arrow('reactions')}
                    </button>
                  </th>
                  <th>Comments</th>
                  <th>Reposts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">
                      {new Date(p.date).toLocaleDateString(undefined, {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        year: '2-digit',
                      })}
                    </td>
                    <td>
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer">
                          {p.preview || '(no text)'}
                        </a>
                      ) : (
                        p.preview || '(no text)'
                      )}{' '}
                      {p.hasMedia && <span className="pill">📷</span>}{' '}
                      {p.viaApp && <span className="pill ok-inline">via app</span>}
                    </td>
                    <td>{p.reactions}</td>
                    <td>{p.comments}</td>
                    <td>{p.reposts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
