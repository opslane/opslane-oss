import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { opslaneSourceMapPlugin } from '@opslane/sdk/vite-plugin';

export default defineConfig({
  plugins: [
    vue(),
    opslaneSourceMapPlugin({
      endpoint: 'http://localhost:8082',
      apiKey: 'e2e-test-key-plaintext',
      release: 'e2e-fixture-v1',
    }),
  ],
});
