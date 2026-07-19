import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/github': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/login': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/config': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/password': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/signup': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/verify-email': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/refresh': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/auth/switch-org': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/oauth': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VITE_API_URL || 'http://localhost:8082',
        changeOrigin: true,
      },
    },
  },
})
