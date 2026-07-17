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
import AcceptInvitation from './views/AcceptInvitation.vue';
import { routeNeedsProject } from './route-project';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { public: true } },
    { path: '/auth/complete', name: 'auth-complete', component: AuthCallback, meta: { public: true } },
    { path: '/invite/accept', name: 'invite-accept', component: AcceptInvitation },
    { path: '/setup', name: 'setup', component: SetupWizard },
    { path: '/', name: 'activity', component: ActivityFeed },
    { path: '/incidents/:id', name: 'incident', component: IncidentDetail },
    { path: '/accounts', name: 'accounts', component: AccountsList },
    { path: '/accounts/:accountId', name: 'account-detail', component: AccountDetail },
    { path: '/sessions', name: 'sessions', component: () => import('./views/SessionsList.vue') },
    { path: '/sessions/:sessionId', name: 'session-detail', component: () => import('./views/SessionDetail.vue') },
    { path: '/settings', name: 'settings', component: Settings },
    { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const authed = isAuthenticated();
  const publicRoutes = ['login', 'auth-complete'];

  if (!to.meta.public && !authed) {
    if (to.name === 'invite-accept') {
      sessionStorage.setItem('opslane_post_auth_path', to.fullPath);
    }
    return { name: 'login' };
  }

  if (publicRoutes.includes(to.name as string) && authed) {
    // Don't redirect auth-complete — it needs to process cookies first
    if (to.name === 'auth-complete') return;
    return { name: 'activity' };
  }

  // Redirect to setup if authenticated but no project configured
  if (authed && routeNeedsProject(to.name)) {
    const hasProject = !!localStorage.getItem('opslane_project_id');
    if (!hasProject) {
      return { name: 'setup' };
    }
  }
});
