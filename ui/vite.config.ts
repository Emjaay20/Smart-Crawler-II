import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
      '/crawl': 'http://127.0.0.1:3000',
      '/status': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/ready': 'http://127.0.0.1:3000',
      '/metrics': 'http://127.0.0.1:3000',
    },
  },
})
