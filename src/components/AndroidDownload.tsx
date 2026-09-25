/**
 * The Android install experience on the Help page.
 *
 * Two honest states, driven entirely by the published release manifest:
 *   - a signed build is available → real download + install steps + checksum
 *   - nothing published yet       → the build-it-yourself instructions
 *
 * Devices/tap targets: the primary action is a full-size anchor styled with the
 * kit's button classes (an <a> rather than a <button> so the browser owns the
 * download — no nested interactive elements, and it keeps its keyboard and
 * focus behaviour for free).
 */
import { useState } from 'react'
import { Check, Copy, Download, ShieldCheck, Terminal } from 'lucide-react'
import { cn } from '../lib/cn'
import { formatBytes, useAndroidRelease, type AndroidRelease } from '../lib/androidRelease'
import { buttonClasses } from './ui'

const CODE_CLASS = 'rounded bg-secondary/40 px-1 py-0.5 font-mono text-xs text-foreground'

export function AndroidDownload() {
  const { state, release, href } = useAndroidRelease()

  if (state === 'checking') {
    return (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Checking for the latest Android build…
      </p>
    )
  }

  if (state === 'available' && release && href) {
    return <PublishedBuild release={release} href={href} />
  }

  return <BuildItYourself />
}

/* --------------------------- Published download ---------------------------- */

function PublishedBuild({ release, href }: { release: AndroidRelease; href: string }) {
  const builtOn = new Date(release.builtAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Install ANA24 on your Android phone — same dashboard, same robot, and it keeps
        trading while the app is closed. Download the file below and install it straight
        from your phone; no Play Store account needed.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <a href={href} download={release.file} className={buttonClasses('primary', 'lg')}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Download APK
        </a>
        <p className="text-xs text-muted-foreground">
          v{release.version} · {formatBytes(release.sizeBytes)} · built {builtOn}
        </p>
      </div>

      <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>Tap <span className="text-foreground">Download APK</span>, then open the file from your notifications or Downloads folder.</li>
        <li>
          If Android blocks it, allow installing from this source — Settings →{' '}
          <span className="text-foreground">Apps → Install unknown apps</span>.
        </li>
        <li>
          Open <span className="text-foreground">ANA24</span> and sign in with your usual account.
          Installing a newer build updates the app in place.
        </li>
      </ol>

      <Checksum sha256={release.sha256} file={release.file} />

      <details className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          Prefer to build it yourself?
        </summary>
        <div className="mt-3">
          <BuildItYourself intro={false} />
        </div>
      </details>
    </div>
  )
}

/* ------------------------------ Checksum ---------------------------------- */

function Checksum({ sha256, file }: { sha256: string; file: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sha256)
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <details className="rounded-xl border border-border/60 bg-background/40 px-4 py-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-foreground">
        <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
        Verify the download
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Compare this SHA-256 with the file you received — it should match byte for byte
          before you install.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 overflow-hidden break-all rounded-lg border border-border/70 bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {sha256}
          </code>
          <button type="button" onClick={copy} className={buttonClasses('secondary', 'sm')}>
            {copied === 'copied' ? (
              <Check className="h-3.5 w-3.5 text-up" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {copied === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          On a computer:{' '}
          <code className={CODE_CLASS}>sha256sum {file}</code>
        </p>
        <p aria-live="polite" className="sr-only">
          {copied === 'copied'
            ? 'Checksum copied to the clipboard'
            : copied === 'failed'
              ? 'Could not copy the checksum — select it and copy manually'
              : ''}
        </p>
        {copied === 'failed' && (
          <p className="text-xs text-down">Couldn't copy that — select the hash and copy it manually.</p>
        )}
      </div>
    </details>
  )
}

/* --------------------------- Build it yourself ----------------------------- */

function BuildItYourself({ intro = true }: { intro?: boolean }) {
  return (
    <div className="space-y-4">
      {intro && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          A signed Android build hasn't been published to this site yet. ANA24 is a Capacitor
          build of this exact app, so you can package it yourself in a few minutes — the native
          project is generated on your machine, which needs an Android SDK. It installs from a
          file; no Play Store and no developer account required.
        </p>
      )}

      <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>
          Create{' '}
          <code className={CODE_CLASS}>.env.local</code> in the repo root with the public values
          below.
        </li>
        <li>
          <code className={CODE_CLASS}>npm install</code>, then once per machine:{' '}
          <code className={CODE_CLASS}>npm run cap:add:android</code>.
        </li>
        <li>
          Build and sign with <code className={CODE_CLASS}>npm run apk:publish</code> — the signed
          APK is written to{' '}
          <code className={CODE_CLASS}>public/downloads/</code> and this page starts offering it
          as a download.
        </li>
      </ol>

      <pre className="overflow-x-auto rounded-xl border border-border/70 bg-background/60 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
{`VITE_SUPABASE_URL=https://xopygzpepikerwqxzqzu.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhvcHlnenBlcGlrZXJ3cXh6cXp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5ODYzMzMsImV4cCI6MjEwMzU2MjMzM30.8jh0Ux_fcb-LJGqtUZVAUqN9fHDNHSffsKlLndzSLzk`}
      </pre>
      <p className="text-xs leading-relaxed text-muted-foreground">
        These are the same public keys shipped in the web app's browser bundle — safe to put in a
        local build file. The build is signed with a keystore the script generates on first run;
        keep that keystore safe, it's what identifies the app across updates.
      </p>

      <a
        href="/ANDROID_APK.md"
        download
        className={cn(buttonClasses('secondary'), 'w-fit')}
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Full build guide
      </a>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Command-line steps need Node 20+, a JDK 17+ and the Android SDK — the full guide covers the
        one-time setup.
      </p>
    </div>
  )
}
