import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { json, requireAuth } from './_lib.js'
import { PLAYBOOK } from './_playbook.js'

// Riff on a draft with Claude, inside Make Me Famous. Claude replies in chat and, when asked for
// a change, returns a full revised post that the author can apply or ignore. Nothing is saved or sent.

const KEY = process.env.ANTHROPIC_API_KEY_MAKE_ME_FAMOUS
const AUTHOR = process.env.AUTHOR_NAME || 'the author'
// One line on who they are and where they sit, e.g. "a product designer in Berlin who writes about onboarding".
const ABOUT = process.env.AUTHOR_ABOUT || ''

const SYSTEM = `You help ${AUTHOR}${ABOUT ? `, ${ABOUT},` : ''} write their LinkedIn posts. You're their sharp, honest writing partner, not a cheerleader.

How to work:
- Talk like a friend who's good at this: short, direct, British spelling, no corporate filler. Push back when something won't land, and say why in a line.
- When they ask for a change (or a change is clearly what they want), return the WHOLE revised post in revised_text. Keep their words wherever they work; change only what earns it. Never invent facts, numbers, names, quotes or events. If a claim needs checking, say so in the reply instead of inventing a fix.
- Keep every "@Name" exactly as written: those are LinkedIn tags. Don't add new @tags.
- If they only ask a question or want opinions, answer in reply and leave revised_text null.
- Same for the first comment: revised_comment only when they ask to change it.
- LinkedIn shows the first ~210 characters before "…more", so the opening has to earn the click.

Their playbook, built from what has actually performed on their LinkedIn:

${PLAYBOOK}`

const Answer = z.object({
  reply: z.string().describe(`What you say back to ${AUTHOR} in the chat. Short.`),
  revised_text: z.string().nullable().describe('The full revised post, or null if no change to the post.'),
  revised_comment: z.string().nullable().describe('The full revised first comment, or null if unchanged.'),
})

const Suggestions = z.object({
  suggestions: z
    .array(
      z.object({
        label: z.string().describe('The change in 3 to 7 words, e.g. "Open on the 8 windows, not the split"'),
        why: z.string().describe('One short sentence on why, tied to their playbook or how LinkedIn reads.'),
        revised_text: z.string().describe('The FULL post with only this one change made.'),
      }),
    )
    .describe('The 3 or 4 changes most likely to make this post do better, best first.'),
})

const SUGGEST = `Without being asked, suggest the 3 or 4 changes most likely to make this post do better with their audience, best first. Each one is a single, specific change (not "make it punchier") applied to an otherwise untouched copy of the post, so they can click to use it. Prefer: the hook (first ~210 characters), anything on their playbook's delete list, length, a missing payoff or ending, and their own voice. Skip a category if the post already nails it. Don't touch the @tags and don't invent facts.`

const SUGGEST_REPLY = `Without being asked, suggest the 2 or 3 changes most likely to make this reply land better, best first. Each one is a single, specific change applied to an otherwise untouched copy of the reply, so they can click to use it. Think: does it answer what they actually said, is it warm and human, is it short enough (1-3 sentences), does it end on something that keeps the conversation going, and does it sound like ${AUTHOR}. Skip anything it already does well. Don't invent facts.`

const ReplyDraft = z.object({
  reply: z.string().describe(`The reply ${AUTHOR} posts under the comment. Usually 1-3 short sentences.`),
})

const REPLY = `Draft ${AUTHOR}'s reply to the LinkedIn comment below, on their post shown above. Write it the way they actually reply: warm, quick, a bit cheeky, British, never corporate. Respond to what THIS person said (pick up their specific point, answer a question if they asked one), and where it fits, end with a short question back so the thread keeps going. 1-3 short sentences. No hashtags, no "Great point!", no "Thanks for sharing", no emoji unless it really lands. Don't start with their name. Never invent facts about ${AUTHOR}, their work or the commenter.`

const COMMENT = `Draft ${AUTHOR}'s comment on the LinkedIn post above (someone else's post). The point of commenting is to be useful and memorable, not to flatter: add something the post doesn't have. A specific take from where they sit${ABOUT ? ` (${ABOUT})` : ''}, a sharp question, a concrete example, or a friendly disagreement. Warm, quick, a bit cheeky, British. 1-3 sentences. Never "Great post", "Love this", "So true", "Thanks for sharing", hashtags or emoji spam. Never invent facts about ${AUTHOR}, their work or the post's author.`

const Commented = z.object({
  author: z.string().max(200),
  headline: z.string().max(400).optional(),
  text: z.string().max(5000),
  replies: z.array(z.object({ author: z.string().max(200), text: z.string().max(3000) })).max(100).optional(),
})

const Turn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(20_000) })
const Body = z.object({
  text: z.string().max(10_000),
  firstComment: z.string().max(2_000).optional(),
  turns: z.array(Turn).max(40).default([]),
  mode: z.enum(['chat', 'suggest', 'reply', 'comment']).default('chat'),
  /** What's being edited: a post (default) or a reply to a comment, with `context` saying what it replies to. */
  kind: z.enum(['post', 'reply']).default('post'),
  context: z.string().max(8_000).optional(),
  comment: Commented.optional(),
})

/** POST /api/riff  {text, firstComment?, turns}  -> {reply, revised_text, revised_comment} */
export async function POST(req: Request) {
  const denied = requireAuth(req)
  if (denied) return denied
  if (!KEY) return json({ error: 'Claude isn’t connected yet: add ANTHROPIC_API_KEY_MAKE_ME_FAMOUS in Vercel.' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'Bad request' }, 400)
  const { text, firstComment, mode, comment, kind, context } = parsed.data
  if ((mode === 'reply' || mode === 'comment') && !comment) return json({ error: 'Bad request' }, 400)
  const replyAsk = comment
    ? `${REPLY}\n\nComment by ${comment.author}${comment.headline ? ` (${comment.headline})` : ''}:\n"""\n${comment.text}\n"""${
        comment.replies?.length
          ? `\n\nReplies already under it:\n${comment.replies.map((r) => `- ${r.author}: ${r.text}`).join('\n')}`
          : ''
      }`
    : ''
  const turns =
    mode === 'suggest'
      ? [{ role: 'user' as const, content: kind === 'reply' ? SUGGEST_REPLY : SUGGEST }]
      : mode === 'reply'
        ? [{ role: 'user' as const, content: replyAsk }]
        : mode === 'comment'
          ? [
              {
                role: 'user' as const,
                content: `${COMMENT}\n\nPost by ${comment?.author}${comment?.headline ? ` (${comment.headline})` : ''}:\n"""\n${comment?.text}\n"""`,
              },
            ]
        : parsed.data.turns
  if (turns.at(-1)?.role !== 'user' || (mode === 'suggest' && !text.trim())) return json({ error: 'Bad request' }, 400)

  // The current draft goes in with the latest message, so Claude always sees what's in the editor now.
  const draft =
    mode === 'comment'
      ? ''
      : kind === 'reply'
      ? `You're helping with a short LinkedIn reply or comment (on someone's comment or post), not a post of their own. Keep it short and conversational (1-3 sentences). In revised_text, return the full revised reply; leave revised_comment null.\n\nWhat it replies to:\n"""\n${context ?? '(not given)'}\n"""\n\nCurrent reply:\n"""\n${text || '(empty)'}\n"""`
      : `Current post:\n"""\n${text || '(empty)'}\n"""\n\nFirst comment:\n"""\n${firstComment?.trim() || '(none)'}\n"""`
  const messages: Anthropic.MessageParam[] = turns.map((t, i) =>
    i === turns.length - 1 ? { role: 'user', content: `${draft}\n\n${t.content}` } : { role: t.role, content: t.content },
  )

  const client = new Anthropic({ apiKey: KEY })
  try {
    const res = await client.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      cache_control: { type: 'ephemeral' },
      output_config: {
        effort: mode === 'reply' || mode === 'comment' ? 'low' : 'medium',
        format: zodOutputFormat(mode === 'suggest' ? Suggestions : mode === 'reply' || mode === 'comment' ? ReplyDraft : Answer),
      },
      system: SYSTEM,
      messages,
    })
    if (res.stop_reason === 'refusal') return json({ error: 'Claude declined that one. Try rewording it.' }, 422)
    if (!res.parsed_output) return json({ error: 'Claude’s answer came back garbled. Try again.' }, 502)
    // Log size only, never content.
    console.log('[riff]', { in: res.usage.input_tokens, out: res.usage.output_tokens, cached: res.usage.cache_read_input_tokens })
    return json(res.parsed_output)
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: 'Claude is busy. Try again in a minute.' }, 429)
    if (e instanceof Anthropic.AuthenticationError) return json({ error: 'The Claude key in Vercel isn’t valid.' }, 503)
    if (e instanceof Anthropic.APIError) return json({ error: `Claude error (${e.status ?? 'network'}). Try again.` }, 502)
    throw e
  }
}
