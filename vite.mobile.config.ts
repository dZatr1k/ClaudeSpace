// The phone app's web part (docs/MOBILE.md): `npm run mobile:web` builds it into out/mobile, Capacitor copies that
// into the Android project. `npm run mobile:dev` serves it on 127.0.0.1 for a phone-sized browser window.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
const port = Number(process.env.MOBILE_PORT ?? 5181);

export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@fonts': resolve(__dirname, 'resources/fonts'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(__dirname, 'out/mobile'), emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    fs: {
      allow: [
        resolve(__dirname, 'src'),
        resolve(__dirname, 'resources/fonts'),
        resolve(__dirname, 'node_modules'),
      ],
    },
  },
});
