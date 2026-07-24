/** Typed failures for the deterministic onboarding plumbing. */

export class LoginFailedError extends Error {
  constructor(message = 'Login did not complete. Re-run to try again.') {
    super(message);
    this.name = 'LoginFailedError';
  }
}

export class NotAuthenticatedError extends Error {
  constructor(message = 'Your session is not valid. Log in again.') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

/** A 403 from the admin-gated provisioning route cannot be fixed by re-login. */
export class NotAuthorizedError extends Error {
  constructor(
    message = 'Provisioning requires an org admin. Ask an org admin to run onboarding or grant you admin.',
  ) {
    super(message);
    this.name = 'NotAuthorizedError';
  }
}

export class ApiUnreachableError extends Error {
  constructor(apiUrl: string) {
    super(`Could not reach the Opslane API at ${apiUrl}.`);
    this.name = 'ApiUnreachableError';
  }
}
