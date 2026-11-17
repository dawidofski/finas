import { describe, expect, it } from 'vitest'
import { strToU8 } from 'fflate'
import { detectFormat, ImportError } from './detect'
import { buildXlsx, FIXTURE_DATA_ROWS, FIXTURE_HEADER_ROWS } from './__fixtures__/build'

const bytes = (...values: number[]) => Uint8Array.from(values)

describe('detectFormat', () => {
  it('detects xlsx, pdf and csv by magic bytes', () => {
    expect(detectFormat(buildXlsx(FIXTURE_HEADER_ROWS, FIXTURE_DATA_ROWS))).toBe('xlsx')
    expect(detectFormat(strToU8('%PDF-1.7\n%binary'))).toBe('pdf')
    expect(detectFormat(strToU8('fecha;importe;saldo\n2026-11-15;-12,45;100,00\n'))).toBe('csv')
    expect(detectFormat(strToU8('fecha,importe\r\n2026-11-15,-12.45\r\n'))).toBe('csv')
    expect(detectFormat(strToU8('﻿fecha\timporte\n2026-11-15\t-12.45\n'))).toBe('csv')
  })

  it('detects XLSX by content, so a zip named .xls is still read as xlsx', () => {
    // The owner's savings export is movements-15112026.xls and is really a ZIP. detectFormat takes no filename at
    // all: the only way it can answer correctly is from the bytes.
    expect(detectFormat.length).toBe(1)
    expect(detectFormat(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0))).toBe('xlsx')
  })

  it('does not take unstructured text for a CSV', () => {
    expect(detectFormat(strToU8('just some words with no structure'))).toBe('unknown')
  })

  it.each([
    ['empty input', new Uint8Array(0)],
    ['a lone PK without the local-header signature', bytes(0x50, 0x4b)],
    ['an empty-archive signature (PK 05 06)', bytes(0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0)],
    ['binary noise with a NUL byte', bytes(0x00, 0x01, 0x02, 0x2c, 0x0a, 0x2c)],
    ['an old binary .xls (OLE2 header)', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x2c, 0x0a)],
  ])('answers unknown for %s', (_label, input) => {
    expect(detectFormat(input)).toBe('unknown')
  })
})

describe('ImportError', () => {
  it('is an Error carrying a code and an owner-facing message', () => {
    const error = new ImportError('empty', 'Nothing in here.')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('empty')
    expect(error.message).toBe('Nothing in here.')
    expect(error.name).toBe('ImportError')
  })
})
