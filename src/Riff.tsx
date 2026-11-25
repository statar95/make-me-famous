import { useEffect, useMemo, useRef, useState } from 'react'
import { rebase } from './diff'
import { Changes } from './Previews'
import { type RiffTarget, type RiffTurn, type Suggestion, riff, riffSuggest } from './store'

interface Msg extends RiffTurn {
  /** The post and first comment as they were when Claude wrote its rewrite. */
  base?: string
  baseComment?: string
  revisedText?: string | null
  revisedComment?: string | null
  applied?: boolean
}

// Suggestions are kept per draft text in this browser, so reopening a post doesn't pay for them again.
const cacheKey = (raw: string) => {
  const text = raw
  let h = 0
  for (const ch of text) h = (Math.imul(31, h) + ch.charCodeAt(0)) | 0
  return `riff-suggest:${h}:${text.length}`
}
const readCache = (text: string): Suggestion[] | null => {
  try {
    const raw = localStorage.getItem(cacheKey(text))
    return raw ? (JSON.parse(raw) as Suggestion[]) : null
  } catch {
    return null
  }
}
const writeCache = (text: string, s: Suggestion[]) => {
  try {
    localStorage.setItem(cacheKey(text), JSON.stringify(s))
  } catch {
    /* storage full or blocked: just don't cache */
  }
}

const QUICK_REPLY = ['Make it warmer', 'Shorter', 'End with a question back', 'More me, less polite']

const QUICK = [
  'Punchier opening line',
  'Cut it to ~150 words',
  'Kill anything that sounds like AI',
  'Make it more me (CAPS, a joke at my expense)',
  'What will people comment?',
]

/**
 * Chat with Claude about the post in the editor. Claude can suggest a full rewrite, which you
 * apply with one click (and undo). The chat isn't saved; the post only changes when you apply.
 */
export function Riff(props: {
  text: string
  firstComment: string
  onApply: (text: string | null, comment: string | null) => void
  onUndo: () => void
  canUndo: boolean
  /** Show a suggestion as track changes in the preview pane (null to stop). */
  onPreview: (p: { label: string; text: string } | null) => void
  /** The suggestion currently shown in the preview pane, if any. */
  previewText?: string
  /** Editing a reply instead of a post: different suggestions and quick prompts. */
  target?: RiffTarget
}) {
  const target = props.target
  const isReply = target?.kind === 'reply'
  const quick = isReply ? QUICK_REPLY : QUICK
  // Suggestions are remembered per text and per what it replies to.
  const memoKey = (t: string) => (isReply ? `${target?.context ?? ''}\n---\n${t}` : t)
  const [open, setOpen] = useState(true)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const [sugg, setSugg] = useState<Suggestion[] | null>(null)
  const [suggFor, setSuggFor] = useState('')
  const [suggBusy, setSuggBusy] = useState(false)
  const [suggError, setSuggError] = useState('')
  // Suggestions used, in order, with the text from before each, so Undo can un-use them.
  const [usedLog, setUsedLog] = useState<{ i: number; before: string }[]>([])
  const used = usedLog.map((u) => u.i)

  const loadSuggestions = async (force = false) => {
    const text = props.text
    if (!text.trim() || suggBusy) return
    const cached = !force && readCache(memoKey(text))
    if (cached) {
      setSugg(cached)
      setSuggFor(text)
      setUsedLog([])
      return
    }
    setSuggBusy(true)
    setSuggError('')
    try {
      const s = await riffSuggest(text, props.firstComment, target)
      writeCache(memoKey(text), s)
      setSugg(s)
      setSuggFor(text)
      setUsedLog([])
        props.onPreview(null)
    } catch (e) {
      setSuggError(e instanceof Error ? e.message : 'Could not get suggestions')
    } finally {
      setSuggBusy(false)
    }
  }

  // Suggestions arrive by themselves once there's text (straight away for a post, or as soon as
  // Claude's first reply draft lands).
  const autoLoaded = useRef(false)
  const hasText = !!props.text.trim()
  useEffect(() => {
    if (!hasText || autoLoaded.current) return
    autoLoaded.current = true
    loadSuggestions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasText])

  // Suggestions stack: each one is re-applied on top of whatever the post is now (earlier
  // suggestions you used, your own edits). null = it clashes with something that's changed.
  const effective = useMemo(
    () => (sugg ?? []).map((s) => rebase(suggFor, s.revised_text, props.text)),
    [sugg, suggFor, props.text],
  )
  const useSuggestion = (i: number) => {
    const next = effective[i]
    if (next === null || next === undefined) return
    props.onApply(next, null)
    setUsedLog([...usedLog, { i, before: props.text }])
    props.onPreview(null)
  }
  const peek = props.previewText !== undefined ? effective.findIndex((t) => t === props.previewText) : -1
  const togglePeek = (i: number) => {
    const next = effective[i]
    if (!sugg || next === null) return
    props.onPreview(peek === i ? null : { label: sugg[i].label, text: next })
  }
  // Undo puts the text back to what it was before the last suggestion: forget that one.
  useEffect(() => {
    const last = usedLog.at(-1)
    if (last && props.text === last.before) setUsedLog(usedLog.slice(0, -1))
  }, [props.text, usedLog])
  const changed = sugg !== null && props.text !== suggFor
  const clashes = effective.filter((t, i) => t === null && !used.includes(i)).length

  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would try to
  // call it as the effect's cleanup and crash the page.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [msgs, busy])

  const send = async (content: string) => {
    const ask = content.trim()
    if (!ask || busy) return
    const next: Msg[] = [...msgs, { role: 'user', content: ask }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    setError('')
    try {
      // Claude's turns carry its reply plus a note of any rewrite, so it remembers what it proposed.
      const turns: RiffTurn[] = next.map((m) => ({
        role: m.role,
        content:
          m.role === 'assistant' && m.revisedText
            ? `${m.content}\n\n[Proposed rewrite${m.applied ? ', which I applied' : ''}:]\n${m.revisedText}`
            : m.content,
      }))
      const a = await riff(props.text, props.firstComment, turns, target)
      setMsgs([
        ...next,
        {
          role: 'assistant',
          content: a.reply,
          base: props.text,
          baseComment: props.firstComment,
          revisedText: a.revised_text && a.revised_text !== props.text ? a.revised_text : null,
          revisedComment: a.revised_comment && a.revised_comment !== props.firstComment ? a.revised_comment : null,
        },
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setMsgs(msgs)
      setInput(ask)
    } finally {
      setBusy(false)
    }
  }

  // A chat rewrite is re-applied on top of anything changed since (like the suggestion cards).
  // If it clashes, using it replaces the whole post with Claude's version, and the card says so.
  const chatVersion = (m: Msg) => {
    if (!m.revisedText) return { text: null as string | null, clash: false }
    const r = m.base !== undefined ? rebase(m.base, m.revisedText, props.text) : null
    return { text: r ?? m.revisedText, clash: r === null && m.base !== props.text }
  }
  const chatComment = (m: Msg) =>
    m.revisedComment ? (m.baseComment !== undefined ? rebase(m.baseComment, m.revisedComment, props.firstComment) : null) ?? m.revisedComment : null

  const apply = (i: number) => {
    const m = msgs[i]
    props.onApply(chatVersion(m).text, chatComment(m))
    setMsgs(msgs.map((x, j) => (j === i ? { ...x, applied: true } : x)))
    props.onPreview(null)
  }

  if (!open)
    return (
      <button className="riff-open" onClick={() => setOpen(true)}>
        <span className="riff-spark">✳︎</span> Riff on this with Claude
      </button>
    )

  return (
    <div className="riff">
      <div className="riff-head">
        <span>
          <span className="riff-spark">✳︎</span> Riff with Claude
        </span>
        <span className="riff-head-actions">
          {props.canUndo && (
            <button className="btn ghost sm" onClick={props.onUndo}>
              Undo last apply
            </button>
          )}
          {msgs.length > 0 && (
            <button className="btn ghost sm" onClick={() => setMsgs([])}>
              New chat
            </button>
          )}
          <button className="btn ghost sm" onClick={() => setOpen(false)}>
            Hide
          </button>
        </span>
      </div>

      <div className="riff-sugg">
        <div className="riff-sugg-head">
          <span className="field-label">Claude's suggestions</span>
          {sugg && !suggBusy && (
            <button className="btn ghost sm" onClick={() => loadSuggestions(true)}>
              {changed ? 'Fresh ideas for this version' : 'New ideas'}
            </button>
          )}
        </div>
        {suggBusy && <div className="riff-empty">Reading your draft and thinking about what would land better… (~20s)</div>}
        {suggError && (
          <div className="riff-error">
            {suggError}{' '}
            <button className="btn ghost sm" onClick={() => loadSuggestions(true)}>
              Try again
            </button>
          </div>
        )}
        {!sugg && !suggBusy && !suggError && (
          <button className="btn ghost sm" onClick={() => loadSuggestions()} disabled={!props.text.trim()}>
            Get suggestions
          </button>
        )}
        {clashes > 0 && !suggBusy && (
          <div className="riff-empty">
            {clashes === 1 ? 'One suggestion clashes' : `${clashes} suggestions clash`} with changes you've made since.
            Get fresh ideas to rework {clashes === 1 ? 'it' : 'them'} for this version.
          </div>
        )}
        {sugg?.map((s, i) => (
          <div
            key={i}
            className={`riff-card ${used.includes(i) ? 'used' : ''} ${peek === i ? 'peeking' : ''} ${effective[i] === null && !used.includes(i) ? 'clash' : ''}`}
          >
            <div className="riff-card-main">
              <div className="riff-card-label">{s.label}</div>
              <div className="riff-card-why">{s.why}</div>
            </div>
            <div className="riff-card-actions">
              {used.includes(i) ? (
                <span className="muted">Used ✓</span>
              ) : effective[i] === null ? (
                <span className="muted">Clashes</span>
              ) : (
                <>
                  <button className="btn ghost sm" onClick={() => togglePeek(i)}>
                    {peek === i ? 'Stop preview' : 'Preview'}
                  </button>
                  <button className="btn sm" onClick={() => useSuggestion(i)}>
                    Use
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="riff-log">
        {!msgs.length && (
          <div className="riff-empty">
            Ask anything about this post, or pick one:
            <div className="riff-chips">
              {quick.map((q) => (
                <button key={q} className="slot" onClick={() => send(q)} disabled={busy}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`riff-msg ${m.role}`}>
            <div className="riff-bubble">{m.content}</div>
            {(m.revisedText || m.revisedComment) && (
              <div className="riff-proposal">
                {m.revisedText && (
                  <>
                    <span className="field-label">Suggested changes to the {isReply ? 'reply' : 'post'}</span>
                    <p>
                      {m.applied ? m.revisedText : <Changes from={props.text} to={chatVersion(m).text!} />}
                    </p>
                  </>
                )}
                {m.revisedComment && (
                  <>
                    <span className="field-label">Suggested changes to the first comment</span>
                    <p>
                      {m.applied ? m.revisedComment : <Changes from={props.firstComment} to={chatComment(m)!} />}
                    </p>
                  </>
                )}
                {!m.applied && chatVersion(m).clash && (
                  <div className="riff-empty">
                    Written before your latest edits, so using it replaces the whole post with this version.
                  </div>
                )}
                <div className="riff-proposal-actions">
                  {m.applied ? (
                    <span className="muted">Applied ✓</span>
                  ) : (
                    <>
                      {m.revisedText && (
                        <button
                          className="btn ghost sm"
                          onClick={() =>
                            props.onPreview(
                              props.previewText === chatVersion(m).text
                                ? null
                                : { label: 'Claude’s rewrite from the chat', text: chatVersion(m).text! },
                            )
                          }
                        >
                          {props.previewText === chatVersion(m).text ? 'Stop preview' : 'Preview'}
                        </button>
                      )}
                      <button className="btn sm" onClick={() => apply(i)}>
                        Use this version
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {busy && <div className="riff-msg assistant"><div className="riff-bubble muted">Thinking…</div></div>}
        {error && <div className="riff-error">{error}</div>}
        <div ref={end} />
      </div>

      <form
        className="riff-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. the Copilot bit feels weak, sharpen it"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
        />
        <button className="btn sm" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
