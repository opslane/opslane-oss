import { createApp } from 'vue';
import App from './App.vue';
import { init, opslaneVuePlugin } from '@opslane/sdk';

init({
  endpoint: 'http://localhost:8082',
  apiKey: 'e2e-test-key-plaintext',
  release: 'e2e-fixture-v1',
  replay: { enabled: true },
});

const app = createApp(App);
app.use(opslaneVuePlugin);
app.mount('#app');
