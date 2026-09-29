import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PROXY_TARGETS } from './server/proxy-targets.mjs';

// Прокси к публичным API бирж — обходит CORS в браузере.
const proxy = Object.fromEntries(
  Object.entries(PROXY_TARGETS).map(([prefix, target]) => [
    prefix,
    {
      target,
      changeOrigin: true,
      secure: true,
      rewrite: (p: string) => p.slice(prefix.length),
    },
  ]),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, host: true, proxy },
  preview: { port: 4173, proxy },
  build: { chunkSizeWarningLimit: 2000 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
