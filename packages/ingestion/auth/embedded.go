package auth

import (
	"context"
	"errors"
)

// PasswordAuthenticator is an optional provider capability for embedded login.
type PasswordAuthenticator interface {
	AuthenticateWithPassword(ctx context.Context, email, password string) (Identity, error)
}

// UserRegistrar is an optional provider capability for embedded registration.
type UserRegistrar interface {
	RegisterUser(ctx context.Context, email, password string) error
}

// EmailVerifier is an optional provider capability for completing verification.
type EmailVerifier interface {
	VerifyEmail(ctx context.Context, pendingAuthenticationToken, code string) (Identity, error)
}

// PasswordResetter is an optional provider capability for password resets.
type PasswordResetter interface {
	StartPasswordReset(ctx context.Context, email string) error
	// CompletePasswordReset returns the provider-confirmed identity whose
	// password was changed. Callers must use this identity, never client input,
	// when revoking local sessions.
	CompletePasswordReset(ctx context.Context, token, newPassword string) (Identity, error)
}

var (
	ErrInvalidCredentials   = errors.New("invalid credentials")
	ErrEmailTaken           = errors.New("email already registered")
	ErrWeakPassword         = errors.New("password does not meet strength requirements")
	ErrUnsupportedChallenge = errors.New("authentication requires an unsupported additional step")
)

// PendingVerificationError carries the state required to continue an
// authentication flow with an emailed verification code.
type PendingVerificationError struct {
	PendingAuthenticationToken string
	EmailVerificationID        string
}

func (*PendingVerificationError) Error() string {
	return "email verification required"
}
