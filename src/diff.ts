export type Piece = { kind: 'same' | 'add' | 'del'; text: string }

/**
 * Word-level diff (words and the whitespace between them), like track changes.
 * Plain LCS: fine for a LinkedIn post (a few hundred words).
 */
export function diffWords(from: string, to: string): Piece[] {
  const a = from.match(/\s+|[^\s]+/g) ?? []
  const b = to.match(/\s+|[^\s]+/g) ?? []
  const n = a.length
  const m = b.length
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: Piece[] = []
  const push = (kind: Piece['kind'], text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) push('same', a[i++]), j++
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++])
    else push('add', b[j++])
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('add', b[j++])
  return groupChanges(out)
}

/**
 * Word diffs interleave ("~~Keen~~ I'm ~~to~~ sure…") because spaces match on both sides.
 * Merge each run of changes (with only spaces between them) into one block: all the old text
 * struck through, then all the new text, like a reviewer's tracked change.
 */
function groupChanges(pieces: Piece[]): Piece[] {
  const res: Piece[] = []
  let k = 0
  while (k < pieces.length) {
    if (pieces[k].kind === 'same') {
      res.push(pieces[k++])
      continue
    }
    let oldText = ''
    let newText = ''
    let end = k
    // Extend over changes and whitespace-only "same" bits that sit between two changes.
    for (let x = k; x < pieces.length; x++) {
      const p = pieces[x]
      if (p.kind === 'same') {
        const nextIsChange = x + 1 < pieces.length && pieces[x + 1].kind !== 'same'
        if (!/^\s+$/.test(p.text) || !nextIsChange) break
        oldText += p.text
        newText += p.text
      } else if (p.kind === 'del') oldText += p.text
      else newText += p.text
      end = x + 1
    }
    // Only spacing changed (e.g. a line break): show the new spacing plainly.
    if (!oldText.trim() && !newText.trim()) res.push({ kind: 'same', text: newText })
    if (oldText.trim()) res.push({ kind: 'del', text: oldText })
    if (oldText.trim() && newText.trim()) res.push({ kind: 'same', text: ' ' })
    if (newText.trim()) res.push({ kind: 'add', text: newText })
    k = end
  }
  return res
}

const tok = (s: string) => s.match(/\s+|[^\s]+/g) ?? []

/** LCS table for token arrays a and b. */
function lcsTable(a: string[], b: string[]) {
  const t = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  return t
}

/** Where each token of a ended up in b (-1 if changed or removed). */
function align(a: string[], b: string[]) {
  const t = lcsTable(a, b)
  const map = new Int32Array(a.length).fill(-1)
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) map[i++] = j++
    else if (t[i + 1][j] >= t[i][j + 1]) i++
    else j++
  }
  return map
}

/** The edits that turn a into b: replace a[start..end) with insert. */
function hunks(a: string[], b: string[]) {
  const t = lcsTable(a, b)
  const out: { start: number; end: number; insert: string[] }[] = []
  let i = 0
  let j = 0
  let cur: { start: number; end: number; insert: string[] } | null = null
  const flush = () => {
    if (cur) out.push(cur)
    cur = null
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      i++
      j++
    } else if (j >= b.length || (i < a.length && t[i + 1][j] >= t[i][j + 1])) {
      cur ??= { start: i, end: i, insert: [] }
      cur.end = ++i
    } else {
      cur ??= { start: i, end: i, insert: [] }
      cur.insert.push(b[j++])
    }
  }
  flush()
  return out
}

/**
 * Re-applies a suggestion (written against `original`) on top of `current`, so suggestions stack:
 * use one, and the others still apply to the new version. Each of the suggestion's edits must land
 * on text that's still unchanged in `current`; if any clashes, returns null.
 */
export function rebase(original: string, suggestion: string, current: string): string | null {
  if (current === original) return suggestion
  const A = tok(original)
  const C = tok(current)
  const map = align(A, C)
  const out = [...C]
  const hs = hunks(A, tok(suggestion)).sort((x, y) => y.start - x.start)
  for (const h of hs) {
    let from: number
    let to: number
    if (h.end > h.start) {
      from = map[h.start]
      for (let k = h.start; k < h.end; k++) if (map[k] < 0 || map[k] !== from + (k - h.start)) return null
      to = map[h.end - 1] + 1
    } else {
      // Pure insertion: anchor between the neighbours, which must still sit side by side.
      const before = h.start > 0 ? map[h.start - 1] : -1
      const after = h.start < A.length ? map[h.start] : C.length
      if (h.start > 0 && before < 0) return null
      if (h.start < A.length && after < 0) return null
      if (h.start > 0 && h.start < A.length && after !== before + 1) return null
      from = to = h.start > 0 ? before + 1 : after
    }
    out.splice(from, to - from, ...h.insert)
  }
  return out.join('')
}
