/**
 * The one definition of "the same text" for comparing names and words: Unicode-decomposed with every combining mark
 * removed, so "Cafetería" and "Cafeteria" fold to the same thing. Case is the caller's choice (the scrubber compares
 * upper-case, search and slugs lower-case), which keeps this a single place to change and nothing to keep equal.
 */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '')
