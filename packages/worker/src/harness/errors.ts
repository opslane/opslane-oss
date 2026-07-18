import type { EvidenceRecord } from '@opslane/shared';

/**
 * Signals that verification could not produce a patch verdict because the
 * sandbox, dependency install, or test runner failed persistently.
 */
export class VerificationInfraError extends Error {
  constructor(
    message: string,
    readonly evidence: EvidenceRecord,
  ) {
    super(message);
    this.name = 'VerificationInfraError';
  }
}
