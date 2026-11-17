import { describe, expect, it } from 'vitest'
import { canonicaliseMerchant, merchantTokens } from './canonicalise'

describe('canonicaliseMerchant', () => {
  it('strips the transaction prefix, the locality and the country code', () => {
    expect(canonicaliseMerchant('Pago en SUPERMERCADO EJEMPLO LOCALIDAD ES')).toBe('Supermercado Ejemplo')
  })
  it('handles every prefix ING uses', () => {
    for (const raw of [
      'Pago en TIENDA UNO ES',
      'Pago Bizum en TIENDA UNO ES',
      'Recibo de TIENDA UNO ES',
      'Compra EN TIENDA UNO ES',
      'Traspaso emitido a TIENDA UNO ES',
      'Traspaso recibido de TIENDA UNO ES',
      'Recibo TIENDA UNO ES',
    ])
      expect(canonicaliseMerchant(raw)).toBe('Tienda Uno')
  })
  it('normalises accents and case without destroying the letters', () => {
    expect(canonicaliseMerchant('Pago en CAFETERÍA ÁNGEL ES')).toBe('Cafetería Ángel')
  })
  it('returns the empty string when every token is stripped, and never a bare prefix', () => {
    expect(canonicaliseMerchant('Pago en ES')).toBe('')
    expect(canonicaliseMerchant('Recibo de')).toBe('')
    expect(canonicaliseMerchant('Pago en')).toBe('')
    expect(canonicaliseMerchant('   ')).toBe('')
    expect(canonicaliseMerchant('')).toBe('')
  })
  it('is idempotent: canonicalising a canonical name changes nothing', () => {
    expect(canonicaliseMerchant('Supermercado Ejemplo')).toBe('Supermercado Ejemplo')
    expect(canonicaliseMerchant('Tienda 24H')).toBe('Tienda 24H')
  })
  it('keeps a digit that is part of the name, and drops a trailing card-terminal number', () => {
    expect(canonicaliseMerchant('Pago en TIENDA 24H LOCALIDAD ES')).toBe('Tienda 24H')
    expect(canonicaliseMerchant('Pago en TIENDA UNO 123456')).toBe('Tienda Uno')
  })
  it('does not treat a two-letter word as a country code unless it is upper-case', () => {
    expect(canonicaliseMerchant('Tienda Es')).toBe('Tienda Es')
  })
  it('leaves a description with no known prefix alone apart from case', () => {
    expect(canonicaliseMerchant('GIMNASIO EJEMPLO')).toBe('Gimnasio Ejemplo')
  })
  it('drops a comma that separates the name from the locality', () => {
    expect(canonicaliseMerchant('Compra EN SUPERMERCADO EJEMPLO, MADRID')).toBe('Supermercado Ejemplo Madrid')
  })
})

describe('merchantTokens', () => {
  it('returns the surviving tokens and an empty array when none survive', () => {
    expect(merchantTokens('Pago en SUPERMERCADO EJEMPLO LOCALIDAD ES')).toEqual(['Supermercado', 'Ejemplo'])
    expect(merchantTokens('Pago en ES')).toEqual([])
  })
})
