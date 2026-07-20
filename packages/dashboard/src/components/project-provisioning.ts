export interface ProvisioningAttempt {
  idempotencyToken: string;
}

export function createProvisioningAttempt(randomUUID: () => string): ProvisioningAttempt {
  return { idempotencyToken: randomUUID() };
}

export function canDismissProvisionedKey(acknowledged: boolean): boolean {
  return acknowledged;
}
