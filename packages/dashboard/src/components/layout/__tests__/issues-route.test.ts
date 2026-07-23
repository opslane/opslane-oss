import { describe, expect, it } from 'vitest';
import { APP_NAVIGATION, isNavigationItemActive } from '../navigation';

describe('issues navigation', () => {
  it('labels the primary list Issues and routes it to issues', () => {
    expect(APP_NAVIGATION[0]).toMatchObject({ label: 'Issues', routeName: 'issues' });
  });

  it('keeps the detail route highlighted under the Issues nav item', () => {
    expect(isNavigationItemActive(APP_NAVIGATION[0]!, 'incident')).toBe(true);
  });
});
