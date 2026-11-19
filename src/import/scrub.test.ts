import { describe, expect, it } from 'vitest'
import { fingerprintAccount, last4Of, nameTokens, parseHeader, scrubAll, scrubDescription } from './scrub'

// Everything here is invented (§34.7): an invented holder and an invented account number of the same shape.
const HOLDER = 'PRUEBA ANÓNIMA TESTER'
const ACCOUNT = 'ES00 1111 2222 33 4444555566'
const TOKENS = nameTokens(HOLDER)

const pad = (cells: string[]): string[] => [...cells, ...Array<string>(7 - cells.length).fill('')]
const GRID = [
  pad(['Número de cuenta', ACCOUNT]),
  pad(['Titular', HOLDER]),
  pad(['Fecha exportación', '15/11/2026 13:18:54']),
  pad(['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)']),
]

describe('parseHeader', () => {
  it('reads account number, holder and export timestamp from the header block', () => {
    const header = parseHeader(GRID)
    expect(header.accountNumber).toBe(ACCOUNT)
    expect(header.holderName).toBe(HOLDER)
    expect(header.exportedAt).toBe('15/11/2026 13:18:54')
  })

  it('refuses a header whose account number is not plausible', () => {
    const bad = GRID.map((r, i) => (i === 0 ? pad(['Número de cuenta', 'N/A']) : r))
    expect(() => parseHeader(bad)).toThrow(/plausible/)
  })

  it('refuses a grid with no header block, naming what is missing', () => {
    expect(() => parseHeader([pad(['x'])])).toThrow(/Número de cuenta/)
  })

  it('does not let the account number or holder survive serialisation or spreading', () => {
    const header = parseHeader(GRID)
    const leaked = JSON.stringify({ ...header }) + JSON.stringify(header)
    expect(leaked).not.toContain('4444555566')
    expect(leaked).not.toContain('TESTER')
  })
})

describe('parseHeader: the layout the bank itself exports', () => {
  // A title in the first column; each label two columns over, indented and closed with a colon; the value in the next cell.
  const BANK = [
    ['Movimientos de la Cuenta', '', '  Número de cuenta:', '0000 1111 2222 33334444', '', '', '', ''],
    ['', '', '  Titular:', 'PRUEBA TESTER EJEMPLO', '', '', '', ''],
    ['', '', '  Fecha exportación:', '16/11/2026 08:00h', '', '', '', ''],
    ['F. VALOR', 'CATEGORÍA', 'SUBCATEGORÍA', 'DESCRIPCIÓN', 'COMENTARIO', 'IMPORTE (€)', 'SALDO (€)', ''],
  ]
  it('finds each entry wherever its label sits in the row', () => {
    const header = parseHeader(BANK)
    expect(header.accountNumber).toBe('0000 1111 2222 33334444')
    expect(header.holderName).toBe('PRUEBA TESTER EJEMPLO')
    expect(header.exportedAt).toBe('16/11/2026 08:00h')
  })
  it('reads a label written without accents or in another case, and a value written after the colon', () => {
    const header = parseHeader([['x', 'NUMERO DE CUENTA: 0000 1111 2222 33334444'], ['', 'titular:', '', 'PRUEBA TESTER'], ['', '', 'Fecha exportación', '16/11/2026']])
    expect(header.accountNumber).toBe('0000 1111 2222 33334444')
    expect(header.holderName).toBe('PRUEBA TESTER')
    expect(header.exportedAt).toBe('16/11/2026')
  })
  it('still refuses a file with no such entry, and does not take a longer label for it', () => {
    expect(() => parseHeader([['', '', '  Número de cuenta destino:', '0000 1111 2222 33334444']])).toThrow(/Número de cuenta/)
  })
})

describe('fingerprintAccount', () => {
  it('fingerprints to 64 lowercase hex, stable for the same number and salt', async () => {
    const a = await fingerprintAccount(ACCOUNT, 'salt-one')
    const b = await fingerprintAccount(ACCOUNT, 'salt-one')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toBe(a)
  })

  it('is stable however the number is spaced, because only the digits count', async () => {
    const spaced = await fingerprintAccount(ACCOUNT, 'salt-one')
    const compact = await fingerprintAccount(ACCOUNT.replace(/ /g, ''), 'salt-one')
    expect(compact).toBe(spaced)
  })

  it('produces different fingerprints for different salts', async () => {
    expect(await fingerprintAccount(ACCOUNT, 'salt-one')).not.toBe(await fingerprintAccount(ACCOUNT, 'salt-two'))
  })

  // STABILITY CONTRACT: the input is `${digits}|${salt}`. A refactor of the separator, order or digit extraction
  // must fail here, because it would silently orphan every stored account.
  it('is pinned to a literal digest', async () => {
    expect(await fingerprintAccount(ACCOUNT, 'salt-one')).toBe(
      '35337bfd8b2c9ea0283ae09a2ab16c126e0d7951f4aaa860cb10d4b01f658ff5',
    )
  })

  it('refuses a value that is not a plausible account number, without quoting it', async () => {
    for (const bad of ['N/A', '', '12 34', '9'.repeat(40)]) {
      await expect(fingerprintAccount(bad, 'salt-one')).rejects.toThrow(/not a plausible account number/)
    }
    await expect(fingerprintAccount('N/A', 'salt-one')).rejects.not.toThrow(/N.A/)
  })
})

describe('last4Of', () => {
  it('returns the last four digits only', () => {
    expect(last4Of(ACCOUNT)).toBe('5566')
  })

  it('refuses a value too short to be an account number', () => {
    expect(() => last4Of('12')).toThrow(/plausible/)
  })
})

describe('nameTokens', () => {
  it('splits on whitespace and drops tokens under three characters', () => {
    expect(nameTokens('  ANA  DE  LA   Vega ')).toEqual(['ANA', 'VEGA'])
    expect(nameTokens('JO LI')).toEqual([])
  })
})

describe('scrubDescription', () => {
  it('scrubs the full holder name from a description', () => {
    expect(scrubDescription('Traspaso emitido a PRUEBA ANONIMA TESTER Tu ahorro crece', TOKENS)).toBe(
      'Traspaso emitido a [redacted] Tu ahorro crece',
    )
  })

  it('scrubs the truncated form ING also writes', () => {
    expect(scrubDescription('Traspaso recibido de PRUEBA ANONIMA Movimiento ING', TOKENS)).toBe(
      'Traspaso recibido de [redacted] Movimiento ING',
    )
  })

  it('matches case- and accent-insensitively', () => {
    expect(scrubDescription('pago a Prueba Anónima Téster hoy', TOKENS)).toBe('pago a [redacted] hoy')
    expect(scrubDescription('pago a prueba anonima tester hoy', nameTokens('PRÚEBA ANÓNIMA'))).toBe('pago a [redacted] tester hoy')
  })

  it('matches a name written with decomposed accents', () => {
    const nfd = 'Téster'
    expect(nfd.normalize('NFC')).not.toBe(nfd)
    expect(scrubDescription(`pago a PRUEBA ${nfd} hoy`, TOKENS)).toBe('pago a [redacted] hoy')
    expect(scrubDescription('pago a TESTER hoy', nameTokens(nfd))).toBe('pago a [redacted] hoy')
  })

  it('scrubs names carrying punctuation, whichever way the header writes them', () => {
    expect(scrubDescription('envio a ANA GARCIA-LOPEZ hoy', nameTokens('Ana Garcia-Lopez'))).toBe('envio a [redacted] hoy')
    expect(scrubDescription('envio a GARCIA LOPEZ hoy', nameTokens('Ana Garcia-Lopez'))).toBe('envio a [redacted] hoy')
    // The one-letter "O" falls under the three-character floor, so the apostrophe name's BRIEN is what is matched.
    expect(scrubDescription("envio a O'BRIEN hoy", nameTokens("Sean O'Brien"))).toBe("envio a O'[redacted] hoy")
    // Spanish header form: surname first, comma-separated.
    const tokens = nameTokens('TESTER, PRUEBA')
    expect(tokens).toEqual(['TESTER', 'PRUEBA'])
    expect(scrubDescription('pago a PRUEBA TESTER hoy', tokens)).toBe('pago a [redacted] hoy')
  })

  it('leaves merchant names untouched', () => {
    const merchants = [
      'SUPERMERCADO EJEMPLO LOCALIDAD ES',
      'Compra EN SUPERMERCADO EJEMPLO, MADRID',
      'Recibo COMERCIO EJEMPLO S.A R.L., LOCALIDAD BRANCH COMERCIO EJEMPLO S.A',
      'Tu ahorro crece otra vez con tu compra de 34 EUR y 78 cts',
    ]
    for (const m of merchants) expect(scrubDescription(m, TOKENS)).toBe(m)
  })

  it('does not scrub a token inside an unrelated word', () => {
    expect(scrubDescription('PRUEBAS Y ANONIMAS TESTERS SL', TOKENS)).toBe('PRUEBAS Y ANONIMAS TESTERS SL')
    expect(scrubDescription('ANA GARCIA', nameTokens('ANA'))).toBe('[redacted] GARCIA')
    expect(scrubDescription('BANANA', nameTokens('ANA'))).toBe('BANANA')
  })

  it('is deterministic: the same input scrubs identically every time', () => {
    const text = 'Traspaso emitido a PRUEBA ANONIMA TESTER Tu ahorro'
    expect(scrubDescription(text, TOKENS)).toBe(scrubDescription(text, TOKENS))
  })

  // Canonical form: a stable redaction is for what the owner reads. The duplicate key does not depend on it (§37).
  describe('is canonical (§36)', () => {
    it('collapses adjacent redactions into exactly one marker', () => {
      const out = scrubDescription('PRUEBA ANONIMA TESTER', TOKENS)
      expect(out).toBe('[redacted]')
    })

    it('scrubs both ING renderings of the same name to the same text', () => {
      const full = scrubDescription('Traspaso emitido a PRUEBA ANONIMA TESTER Tu ahorro crece', TOKENS)
      const truncated = scrubDescription('Traspaso emitido a PRUEBA ANONIMA Tu ahorro crece', TOKENS)
      expect(truncated).toBe(full)
      expect(full).toBe('Traspaso emitido a [redacted] Tu ahorro crece')
    })

    it('does not depend on how many tokens the file header supplied', () => {
      // One export's header carries the full name, another a shortened one; the description is the same.
      const text = 'Traspaso recibido de PRUEBA ANONIMA Movimiento ING'
      expect(scrubDescription(text, nameTokens('PRUEBA ANONIMA TESTER'))).toBe(
        scrubDescription(text, nameTokens('PRUEBA ANONIMA')),
      )
    })

    it('does not depend on the spacing or case between the name parts', () => {
      expect(scrubDescription('de Prueba   Anonima\tTester ING', TOKENS)).toBe('de [redacted] ING')
    })

    it('joins a comma-separated name into one marker', () => {
      expect(scrubDescription('TESTER, PRUEBA ANONIMA', TOKENS)).toBe('[redacted]')
    })

    it('keeps two names separated by real text as two markers', () => {
      expect(scrubDescription('PRUEBA paga a TESTER', TOKENS)).toBe('[redacted] paga a [redacted]')
    })
  })
})

describe('scrubAll', () => {
  it('counts what it scrubbed, and quotes none of it', () => {
    const { descriptions, report } = scrubAll(
      ['Traspaso a PRUEBA ANONIMA TESTER', 'Compra EN SUPERMERCADO EJEMPLO', 'Recibo de PRUEBA'],
      TOKENS,
    )
    expect(descriptions).toEqual(['Traspaso a [redacted]', 'Compra EN SUPERMERCADO EJEMPLO', 'Recibo de [redacted]'])
    expect(report).toEqual({ descriptionsScrubbed: 2, tokensUsed: 3 })
    expect(JSON.stringify(report)).not.toMatch(/PRUEBA|TESTER|AN[OÓ]NIMA/)
  })
})
