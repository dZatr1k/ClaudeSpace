// Standalone dev server for the startup splash preview (src/renderer/splash/preview.html): `npm run splash`.
// Hot reload: edits to Splash.tsx / splash.css / tokens.css show up without restarting anything.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const port = Number(process.env.SPLASH_PORT ?? 5180);

export default defineConfig({
  root: resolve(__dirname, 'src/renderer/splash'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@fonts': resolve(__dirname, 'resources/fonts'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'splash-index',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/preview.html' + req.url.slice(1);
          next();
        });
      },
    },
  ],
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
