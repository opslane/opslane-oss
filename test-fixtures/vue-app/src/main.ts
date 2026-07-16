import { createApp } from 'vue';
import App from './App.vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';

// Endpoint/key are overridable so the same fixture drives any local stack
// (e.g. the Batch 4 dogfood on non-default ports, or a staging environment
// key for isolation runs). Defaults preserve the standard compose setup.
init({
  endpoint: import.meta.env['VITE_OPSLANE_ENDPOINT'] ?? 'http://localhost:8082',
  apiKey: import.meta.env['VITE_OPSLANE_API_KEY'] ?? 'e2e-test-key-plaintext',
  release: 'e2e-fixture-v1',
  replay: { enabled: true },
});

const app = createApp(App);
app.use(opslaneVuePlugin);
app.mount('#app');
