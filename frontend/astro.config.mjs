// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [react()],

  vite: {
    plugins: [tailwindcss()],
    
    // 开发服务器代理配置
    server: {
      proxy: {
        // 代理所有 API 请求到 Deno 后端
        '/gh': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/ghraw': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/codeload': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/objects': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/release-assets': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/api.github.com': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/v2': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/ghcr': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/gcr': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/k8s': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/quay': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/health': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/metrics': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
        '/ratelimit': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
      }
    }
  }
});