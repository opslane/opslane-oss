// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import AppNavigation from '../AppNavigation.vue';
import { APP_NAVIGATION } from '../navigation';

const stub = { template: '<div />' };

async function mountNav(showAdmin: boolean, path = '/') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: APP_NAVIGATION.map((item) => ({
      path: item.routeName === 'activity' ? '/' : `/${item.routeName}`,
      name: item.routeName,
      component: stub,
    })),
  });
  await router.push(path);
  await router.isReady();
  return mount(AppNavigation, { props: { showAdmin }, global: { plugins: [router] } });
}

const publicLabels = APP_NAVIGATION.filter((item) => !item.adminOnly).map((item) => item.label);
const adminLabels = APP_NAVIGATION.filter((item) => item.adminOnly).map((item) => item.label);

describe('AppNavigation admin gating', () => {
  it('hides admin-only items from non-admins', async () => {
    const wrapper = await mountNav(false);
    for (const label of adminLabels) expect(wrapper.text()).not.toContain(label);
  });

  it('shows admin-only items to admins', async () => {
    const wrapper = await mountNav(true);
    for (const label of adminLabels) expect(wrapper.text()).toContain(label);
  });

  it('shows every non-admin item to both roles', async () => {
    for (const showAdmin of [false, true]) {
      const text = (await mountNav(showAdmin)).text();
      for (const label of publicLabels) expect(text).toContain(label);
    }
  });

  it('renders exactly the admin-only difference between the two roles', async () => {
    // Guards against the filter being inverted or dropped: if `adminOnly` were
    // ignored, both counts would match and admin nav would leak to every user.
    const adminLinks = (await mountNav(true)).findAll('a').length;
    const userLinks = (await mountNav(false)).findAll('a').length;
    expect(userLinks).toBe(publicLabels.length);
    expect(adminLinks - userLinks).toBe(adminLabels.length);
  });
});

describe('AppNavigation active-route marking', () => {
  it('marks only the current route with aria-current="page"', async () => {
    const wrapper = await mountNav(true, '/settings');
    const current = wrapper.findAll('a').filter((link) => link.attributes('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.text()).toContain('Settings');
  });

  it('marks the parent item when on a related detail route', async () => {
    // 'incident' is a related route of 'activity'; the ledger entry stays lit.
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        ...APP_NAVIGATION.map((item) => ({
          path: item.routeName === 'activity' ? '/' : `/${item.routeName}`,
          name: item.routeName,
          component: stub,
        })),
        { path: '/incidents/:id', name: 'incident', component: stub },
      ],
    });
    await router.push('/incidents/incident-1');
    await router.isReady();
    const wrapper = mount(AppNavigation, { props: { showAdmin: false }, global: { plugins: [router] } });
    const current = wrapper.findAll('a').filter((link) => link.attributes('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.text()).toContain('Incidents');
  });
});
