package auth_test

import (
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

func TestRoleSatisfies(t *testing.T) {
	if !auth.RoleSatisfies("owner", "admin") {
		t.Fatal("owner should satisfy admin")
	}
	if auth.RoleSatisfies("member", "admin") {
		t.Fatal("member must not satisfy admin")
	}
	if auth.RoleSatisfies("unknown", "member") {
		t.Fatal("unknown roles must fail closed")
	}
}
