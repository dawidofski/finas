import { zipParts } from './build'

/**
 * A ZIP64 archive whose central-directory entry announces a 0xFFFFFFFF compressed size (so the reader must go
 * looking for the ZIP64 extra field) but carries no such field. fflate 0.8.2's reader looped forever on exactly
 * this archive (verified: it never returned); 0.8.3 throws "invalid zip data".
 *
 * Built by patching a real archive: insert a ZIP64 end-of-central-directory record and locator before the classic
 * end record, flag the entry's size and the end record's offset as "see ZIP64", and provide no ZIP64 field.
 */
export const buildZip64WithoutExtraField = (): Uint8Array => {
  const source = zipParts({ 'xl/worksheets/sheet1.xml': '<worksheet/>' })
  const src = new DataView(source.buffer, source.byteOffset, source.byteLength)
  const eocd = source.length - 22
  const cdSize = src.getUint32(eocd + 12, true)
  const cdOffset = src.getUint32(eocd + 16, true)
  const z64At = eocd
  const out = new Uint8Array(eocd + 56 + 20 + 22)
  out.set(source.subarray(0, eocd))
  const dv = new DataView(out.buffer)
  dv.setUint32(cdOffset + 20, 0xffffffff, true) // central entry: compressed size is "in the ZIP64 field"
  dv.setUint32(z64At, 0x06064b50, true) // ZIP64 end-of-central-directory record
  dv.setBigUint64(z64At + 4, 44n, true)
  dv.setUint32(z64At + 24, 1, true) // entries on this disk
  dv.setUint32(z64At + 32, 1, true) // total entries
  dv.setUint32(z64At + 40, cdSize, true)
  dv.setUint32(z64At + 48, cdOffset, true)
  const locator = z64At + 56
  dv.setUint32(locator, 0x07064b50, true) // ZIP64 end-of-central-directory locator
  dv.setBigUint64(locator + 8, BigInt(z64At), true)
  dv.setUint32(locator + 16, 1, true)
  const end = locator + 20
  out.set(source.subarray(eocd), end)
  dv.setUint16(end + 8, 1, true)
  dv.setUint16(end + 10, 1, true)
  dv.setUint32(end + 16, 0xffffffff, true) // central-directory offset "in the ZIP64 record"
  return out
}
