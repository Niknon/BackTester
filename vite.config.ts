import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PROXY_TARGETS, proxyTarget } from './server/proxy-targets.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 BackTester/0.1';

// Прокси к публичным API — обходит CORS в браузере.
const proxy = Object.fromEntries(
  Object.entries(PROXY_TARGETS).map(([prefix, value]) => {
    const { target, headers } = proxyTarget(value);
    return [
      prefix,
      {
        target,
        changeOrigin: true,
        secure: true,
        rewrite: (p: string) => p.slice(prefix.length),
        // часть API (Yahoo) отвечает 429/403 на запросы с Origin/Referer localhost или без «браузерного» User-Agent
        configure: (px: any) =>
          px.on('proxyReq', (req: any) => {
            req.removeHeader('origin');
            req.removeHeader('referer');
            // браузерные заголовки (sec-ch-ua, sec-fetch-*, cookie) противоречат подставленному User-Agent —
            // часть источников (SEC) такие запросы блокирует
            for (const h of req.getHeaderNames()) if (/^sec-|^cookie$|^accept-language$/.test(h)) req.removeHeader(h);
            req.setHeader('user-agent', UA);
            for (const [k, v] of Object.entries(headers)) req.setHeader(k, v as string);
          }),
      },
    ];
  }),
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
