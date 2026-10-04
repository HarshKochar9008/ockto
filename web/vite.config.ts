import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  server: {
    // Object form on purpose: the string shorthand sets changeOrigin, which rewrites Host,
    // and the API refuses writes whose Origin host differs from Host (its CSRF check).
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3000' } },
    fs: { allow: ['..'] }, // ../shared
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
