import { describe, expect, it, vi } from 'vitest';

import {
  canDismissProvisionedKey,
  createProvisioningAttempt,
} from './project-provisioning';

describe('project provisioning key acknowledgement', () => {
  it('creates one idempotency token for an attempt session', () => {
    const randomUUID = vi.fn().mockReturnValue('attempt-uuid');
    const attempt = createProvisioningAttempt(randomUUID);

    expect(attempt.idempotencyToken).toBe('attempt-uuid');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('does not allow the one-time key to be dismissed before acknowledgement', () => {
    expect(canDismissProvisionedKey(false)).toBe(false);
    expect(canDismissProvisionedKey(true)).toBe(true);
  });
});
