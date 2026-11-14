import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    build: { externalizeDeps: true, outDir: 'out/main' },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    build: {
      externalizeDeps: true,
      outDir: 'out/preload',
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].js' } },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { outDir: 'out/renderer', rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
    resolve: { alias: { '@shared': shared, '@fonts': resolve(__dirname, 'resources/fonts') } },
    plugins: [react(), tailwindcss()],
  },
});
