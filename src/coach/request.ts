import { monthLine, type CoachMonth } from './context'

/** The one address this application ever sends anything to, and only when the owner presses send on a text they have read. */
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
export const DEEPSEEK_MODEL = 'deepseek-chat'
export const QUESTION_MAX_CHARS = 1000

const SYSTEM = 'You are a careful personal finance coach. The person shares monthly totals from their own records, in euros. '
  + 'Use only the figures given and never invent one. Say so when the figures are too few to support an answer. '
  + 'Suggest small, concrete steps, and do not judge the person. You are not a licensed financial adviser, and say so if asked for investment advice.'

/**
 * What the owner would paste into a chat by hand: their question, then the totals, one month per line. Nothing else goes
 * into a request, and a month line is built from CoachMonth alone, which holds totals and nothing that names a purchase.
 */
export function questionText(question: string, months: readonly CoachMonth[]): string {
  return `${question.trim()}\n\nMy monthly totals:\n${months.map(monthLine).join('\n')}`
}

/**
 * The exact text of the request body. The screen shows THIS string and sends THIS string: it is built once, kept, and
 * handed to sendRequest unchanged, so what the owner approved and what leaves the device cannot differ.
 */
export function buildRequest(question: string, months: readonly CoachMonth[]): string {
  return JSON.stringify({
    model: DEEPSEEK_MODEL,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: questionText(question, months) },
    ],
  }, null, 2)
}

export type SendResult =
  | { ok: true; reply: string }
  /** blocked: the request never completed (the browser refused the connection, or the device is offline). */
  | { ok: false; kind: 'blocked' }
  /** refused: DeepSeek answered with an error status. */
  | { ok: false; kind: 'refused'; status: number }
  /** unreadable: DeepSeek answered, and the answer held no text. */
  | { ok: false; kind: 'unreadable' }

function replyOf(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return null
  const first: unknown = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' && content.trim() !== '' ? content : null
}

/**
 * Sends `body` exactly as given. No cookie or referrer goes with it; the key goes only in the Authorization header, to
 * DEEPSEEK_URL and nowhere else. A browser that refuses the connection and a device that is offline both reject the same
 * way, so 'blocked' claims neither. Never throws.
 */
export async function sendRequest(body: string, key: string): Promise<SendResult> {
  let response: Response
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    })
  } catch { return { ok: false, kind: 'blocked' } }
  if (!response.ok) return { ok: false, kind: 'refused', status: response.status }
  try {
    const reply = replyOf(await response.json())
    return reply === null ? { ok: false, kind: 'unreadable' } : { ok: true, reply }
  } catch { return { ok: false, kind: 'unreadable' } }
}
