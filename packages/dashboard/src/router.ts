import { createRouter, createWebHistory } from 'vue-router';
import { isAuthenticated } from './api';
import ActivityFeed from './views/ActivityFeed.vue';
import AuthCallback from './views/AuthCallback.vue';
import IncidentDetail from './views/IncidentDetail.vue';
import Login from './views/Login.vue';
import SetupWizard from './views/SetupWizard.vue';
import Settings from './views/Settings.vue';
import AccountsList from './views/AccountsList.vue';
import AccountDetail from './views/AccountDetail.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { public: true } },
    { path: '/auth/callback', name: 'auth-callback', component: AuthCallback, meta: { public: true } },
    { path: '/setup', name: 'setup', component: SetupWizard },
    { path: '/', name: 'activity', component: ActivityFeed },
    { path: '/incidents/:id', name: 'incident', component: IncidentDetail },
    { path: '/accounts', name: 'accounts', component: AccountsList },
    { path: '/accounts/:accountId', name: 'account-detail', component: AccountDetail },
    { path: '/sessions', name: 'sessions', component: () => import('./views/SessionsList.vue') },
    { path: '/sessions/:sessionId', name: 'session-detail', component: () => import('./views/SessionDetail.vue') },
    { path: '/settings', name: 'settings', component: Settings },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const authed = isAuthenticated();
  const publicRoutes = ['login', 'auth-callback'];

  if (!to.meta.public && !authed) {
    return { name: 'login' };
  }

  if (publicRoutes.includes(to.name as string) && authed) {
    // Don't redirect auth-callback — it needs to process tokens first
    if (to.name === 'auth-callback') return;
    return { name: 'activity' };
  }

  // Redirect to setup if authenticated but no project configured
  if (authed && to.name !== 'setup' && to.name !== 'login' && to.name !== 'auth-callback') {
    const hasProject = !!localStorage.getItem('opslane_project_id');
    if (!hasProject) {
      return { name: 'setup' };
    }
  }
});
