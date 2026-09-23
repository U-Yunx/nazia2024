import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'

// Custom plugin to handle ?import&react syntax (alias to ?react)
const svgImportPlugin = () => ({
  name: 'svg-import-alias',
  resolveId(id: string) {
    // Transform ?import&react to ?react for vite-plugin-svgr
    if (id.includes('?import&react')) {
      return id.replace('?import&react', '?react');
    }
    return null;
  },
});

// Build-only guard: the NativelyAI preview runtime injects a
// <script src="/natively-runtime.js"> tag into index.html during
// development (and it sometimes gets persisted into the source file).
// That file does not exist in the repo, so `vite build` fails on the
// unresolvable reference. Strip it during production builds — before
// Vite resolves the HTML — while leaving the dev server untouched.
const stripPreviewRuntime = () => ({
  name: 'strip-preview-runtime',
  apply: 'build' as const,
  transformIndexHtml: {
    order: 'pre' as const,
    handler(html: string) {
      return html.replace(
        /<script\b[^>]*\bsrc=["']\/natively-runtime\.js["'][^>]*>\s*<\/script>\s*/gi,
        '',
      );
    },
  },
});

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    react(),
    tailwindcss(),
    svgImportPlugin(),
    stripPreviewRuntime(),
    svgr({
      // Support named ReactComponent export (for ?react syntax)
      svgrOptions: {
        exportType: 'named',
        namedExport: 'ReactComponent',
        ref: true,
        svgo: false,
        titleProp: true,
      },
      include: '**/*.svg?react',
    }),
  ],
  server: {
    allowedHosts: true as const,
    hmr: false,
  },
}))