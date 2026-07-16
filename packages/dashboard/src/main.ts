import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './style.css';

const app = createApp(App);
app.use(router);
// Wait for the initial navigation so route.name is resolved before App.vue's
// mounted hooks run route-dependent checks (e.g. the /admin project exemption).
void router.isReady().then(() => app.mount('#app'));
