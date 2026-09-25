/**
 * Android release manifest — the download contract between the build pipeline
 * and the site.
 *
 * `scripts/publish-apk.mjs` copies the signed APK into `public/downloads/` and
 * writes `public/downloads/latest.json` beside it. The app reads that manifest
 * at runtime, so the download buttons on the Help page and the landing page
 * switch themselves on as soon as a build has been published — and show a
 * "not published yet" note with a contact link while none has been (the
 * committed default is `available: false`).
 *
 * It is a plain same-origin static file, so it also resolves in the Capacitor
 * WebView and offline: the manifest ships inside the APK's own assets.
 */
import { useEffect, useState } from 'react'

/** Vite's BASE_URL keeps this correct if the app is ever served from a subpath. */
export const ANDROID_MANIFEST_PATH = `${import.meta.env?.BASE_URL ?? '/'}downloads/latest.json`

export interface AndroidRelease {
  /** File name inside /downloads, e.g. "ana24-1.0.0.apk". */
  file: string
  /** Version stamped into the APK (android versionName). */
  version: string
  /** Android versionCode — monotonic, so upgrades are accepted. */
  versionCode: number
  /** APK size in bytes. */
  sizeBytes: number
  /** SHA-256 of the APK, so a download can be verified. */
  sha256: string
  /** ISO timestamp of the build that produced the APK. */
  builtAt: string
  /** Whether a v2/v3 signature block was detected at publish time. */
  signed: boolean
}

export type AndroidReleaseState = 'checking' | 'available' | 'unavailable'

/** Same-origin URL of a published APK. */
export function apkUrl(file: string): string {
  return `${import.meta.env?.BASE_URL ?? '/'}downloads/${file}`
}

/**
 * "5.2 MB" / "840 KB". Used on the download button so nobody taps a download
 * on mobile data without knowing what it costs.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / 1024 / 1024
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const FILE_PATTERN = /^[A-Za-z0-9._-]+\.apk$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

/**
 * Validate an untrusted manifest before the UI trusts it. The file name is
 * constrained to a flat .apk name so a tampered manifest can never turn the
 * download link into a path somewhere else on the host.
 */
export function parseAndroidManifest(raw: unknown): AndroidRelease | null {
  if (!raw || typeof raw !== 'object') return null

  const { available, release } = raw as { available?: unknown; release?: unknown }
  if (available !== true || !release || typeof release !== 'object') return null

  const r = release as Partial<Record<keyof AndroidRelease, unknown>>
  if (typeof r.file !== 'string' || !FILE_PATTERN.test(r.file)) return null
  if (typeof r.version !== 'string' || r.version.length === 0) return null
  if (typeof r.versionCode !== 'number' || !Number.isFinite(r.versionCode)) return null
  if (typeof r.sizeBytes !== 'number' || !Number.isFinite(r.sizeBytes) || r.sizeBytes <= 0) return null
  if (typeof r.sha256 !== 'string' || !SHA256_PATTERN.test(r.sha256)) return null
  if (typeof r.builtAt !== 'string' || Number.isNaN(Date.parse(r.builtAt))) return null

  return {
    file: r.file,
    version: r.version,
    versionCode: r.versionCode,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256.toLowerCase(),
    builtAt: r.builtAt,
    // Older manifests predate the field; assume signed rather than alarming.
    signed: r.signed === undefined ? true : r.signed === true,
  }
}

/**
 * Fetch the published Android release once per mount.
 *
 * Every failure path (offline, 404 on a fresh checkout, malformed JSON) resolves
 * to "unavailable" — the caller then shows build instructions instead of a
 * download button that would 404.
 */
export function useAndroidRelease(): {
  state: AndroidReleaseState
  release: AndroidRelease | null
  href: string | null
} {
  const [state, setState] = useState<AndroidReleaseState>('checking')
  const [release, setRelease] = useState<AndroidRelease | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    fetch(ANDROID_MANIFEST_PATH, { signal: controller.signal, cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!active) return
        const parsed = parseAndroidManifest(data)
        setRelease(parsed)
        setState(parsed ? 'available' : 'unavailable')
      })
      .catch(() => {
        if (!active) return
        setRelease(null)
        setState('unavailable')
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [])

  return { state, release, href: release ? apkUrl(release.file) : null }
}
