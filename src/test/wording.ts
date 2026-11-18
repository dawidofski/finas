import { afterAll, afterEach, expect } from 'vitest'
import { BANNED_LISTS, WORDING_LISTS } from './bannedWords'
import { appSpoken } from './spoken'

/**
 * Registers, for the test file that calls it, a scan of EVERYTHING THE APP SAYS on the page each test leaves behind,
 * against both sets of wording lists (BANNED_LISTS and WORDING_LISTS). Every state a test reaches is scanned, not just
 * the one a dedicated "wording" test remembered to set up, so a new sentence on any path is covered the day it is written.
 *
 * `ownerText` is a CSS selector for what the owner wrote (a description, a merchant, a note): it is removed first, since
 * the app repeating the owner's words is not the app judging them. Anything in <q> is removed too.
 *
 * It fails the test that rendered the sentence, naming the list and the words, and `afterAll` fails the file if fewer than
 * `atLeast` pages had any text to scan, because a scan over nothing passes on anything.
 */
export function guardWording(atLeast: number, ownerText = ''): void {
  let scanned = 0
  afterEach(() => {
    const said = appSpoken(document.body, ownerText)
    if (said.trim().length < 40) return
    scanned += 1
    const hits = [...BANNED_LISTS, ...WORDING_LISTS].flatMap((l) => {
      const m = new RegExp(l.pattern.source, l.pattern.flags.replace('g', '')).exec(said)
      return m === null ? [] : [`${l.name}: "${m[0]}" in "…${said.slice(Math.max(0, m.index - 50), m.index + m[0].length + 40).replace(/\s+/g, ' ')}…"`]
    })
    expect(hits, 'wording lists tripped by what the app says on this page').toEqual([])
  })
  afterAll(() => { expect(scanned, 'pages scanned for banned wording').toBeGreaterThanOrEqual(atLeast) })
}
