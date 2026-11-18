/**
 * What the page SAYS, as one string, for every test that scans rendered wording against a banned list.
 *
 * `textContent` joins adjacent elements with no separator ("worked outComponent weight"), so a `\b` word-boundary
 * pattern never fires on a word that starts or ends at an element boundary: a scan of `textContent` is blind to
 * exactly the wording that a layout change would introduce. This puts a space either side of every element before
 * reading, so each element's text is a separate run of words, as a reader (or a screen reader) takes it.
 *
 * Reads a CLONE, so the page under test is not changed. Use it for wording scans only: exact-text assertions and
 * date or figure scans should keep reading `textContent`, where the extra spaces would be noise.
 */
export function spoken(root: Element = document.body): string {
  const clone = root.cloneNode(true) as Element
  for (const el of clone.querySelectorAll('*')) { el.insertAdjacentText('beforebegin', ' '); el.insertAdjacentText('afterend', ' ') }
  return clone.textContent ?? ''
}

/** The same, with the owner's own words (everything rendered in <q>) taken out: the app speaking, not the owner quoted. */
export function appSpoken(root: Element = document.body): string {
  const clone = root.cloneNode(true) as Element
  for (const q of clone.querySelectorAll('q')) q.remove()
  return spoken(clone)
}
