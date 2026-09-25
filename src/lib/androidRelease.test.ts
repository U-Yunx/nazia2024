import { describe, expect, it } from 'vitest'
import { formatBytes, parseAndroidManifest } from './androidRelease'

const VALID = {
  available: true,
  generatedAt: '2026-06-30T10:00:00.000Z',
  release: {
    file: 'ana24-1.0.0.apk',
    version: '1.0.0',
    versionCode: 10000,
    sizeBytes: 5_242_880,
    sha256: 'a'.repeat(64),
    builtAt: '2026-06-30T09:59:00.000Z',
    signed: true,
    kind: 'release',
  },
}

describe('parseAndroidManifest', () => {
  it('accepts a manifest published by the release script', () => {
    const parsed = parseAndroidManifest(VALID)
    expect(parsed).not.toBeNull()
    expect(parsed?.file).toBe('ana24-1.0.0.apk')
    expect(parsed?.version).toBe('1.0.0')
    expect(parsed?.sizeBytes).toBe(5_242_880)
    expect(parsed?.signed).toBe(true)
  })

  it('treats the committed placeholder as "no published build"', () => {
    expect(parseAndroidManifest({ available: false, generatedAt: null, release: null })).toBeNull()
  })

  it('rejects anything malformed instead of throwing', () => {
    expect(parseAndroidManifest(null)).toBeNull()
    expect(parseAndroidManifest('nope')).toBeNull()
    expect(parseAndroidManifest({})).toBeNull()
    expect(parseAndroidManifest({ available: true })).toBeNull()
    expect(parseAndroidManifest({ available: 'true', release: VALID.release })).toBeNull()
  })

  it('rejects a release missing any field the UI needs', () => {
    for (const key of ['file', 'version', 'versionCode', 'sizeBytes', 'sha256', 'builtAt'] as const) {
      const release: Record<string, unknown> = { ...VALID.release }
      delete release[key]
      expect(parseAndroidManifest({ available: true, release }), `missing ${key}`).toBeNull()
    }
  })

  it('rejects a file name that could escape /downloads', () => {
    expect(
      parseAndroidManifest({
        available: true,
        release: { ...VALID.release, file: '../../etc/passwd.apk' },
      }),
    ).toBeNull()
    expect(
      parseAndroidManifest({ available: true, release: { ...VALID.release, file: 'ana24.apk?x=1' } }),
    ).toBeNull()
  })

  it('rejects a bad checksum or unparseable build date', () => {
    expect(
      parseAndroidManifest({ available: true, release: { ...VALID.release, sha256: 'too-short' } }),
    ).toBeNull()
    expect(
      parseAndroidManifest({ available: true, release: { ...VALID.release, builtAt: 'not-a-date' } }),
    ).toBeNull()
  })

  it('assumes a signature for manifests written before the field existed', () => {
    const release: Record<string, unknown> = { ...VALID.release }
    delete release.signed
    expect(parseAndroidManifest({ available: true, release })?.signed).toBe(true)
  })
})

describe('formatBytes', () => {
  it('reports megabytes and kilobytes', () => {
    expect(formatBytes(5_242_880)).toBe('5.0 MB')
    expect(formatBytes(860_160)).toBe('840 KB')
  })

  it('never renders nonsense for a bad size', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})
