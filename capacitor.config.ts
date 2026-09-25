import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor configuration for the ANA24 Android APK.
 *
 * The web build (Vite) outputs to `dist/` — Capacitor packages that output
 * into the native Android project, so the app runs offline inside the WebView
 * with the exact same UI as the web app.
 *
 * NOTE: `appId` is the Android application ID (reverse-DNS). If you ever
 * change it after the first release, Android treats it as a *different app*.
 */
const config: CapacitorConfig = {
  appId: 'com.ana24.trader',
  appName: 'ANA24',
  webDir: 'dist',

  android: {
    // All Supabase traffic is HTTPS, and the WebView serves the app over the
    // built-in local https server (androidScheme defaults to 'https'). There
    // is no legitimate reason to allow mixed HTTP content.
    allowMixedContent: false,
  },
}

export default config
