package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func TestInvitationAcceptanceIsSingleUseEmailBoundAndNotTargetAdminGated(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	targetOrg, _ := q.CreateOrg(ctx, "invite-target")
	personalOrg, _ := q.CreateOrg(ctx, "invite-personal")
	otherOrg, _ := q.CreateOrg(ctx, "invite-other")
	t.Cleanup(func() {
		cleanupTenantHandler(t, pool, targetOrg.ID)
		cleanupTenantHandler(t, pool, personalOrg.ID)
		cleanupTenantHandler(t, pool, otherOrg.ID)
	})
	inviter, _ := q.CreateUserGitHub(ctx, targetOrg.ID, fmt.Sprintf("inviter-%d@example.com", time.Now().UnixNano()), "Inviter", time.Now().UnixNano(), "inviter", "")
	_ = q.CreateMembership(ctx, inviter.ID, targetOrg.ID, "admin")
	inviteeEmail := fmt.Sprintf("Invitee-%d@Example.com", time.Now().UnixNano())
	invitee, _ := q.CreateUserGitHub(ctx, personalOrg.ID, inviteeEmail, "Invitee", time.Now().UnixNano(), "invitee", "")
	_ = q.CreateMembership(ctx, invitee.ID, personalOrg.ID, "owner")
	_ = q.UpsertIdentityDetails(ctx, invitee.ID, "workos", "invitee-"+invitee.ID, inviteeEmail, true)
	other, _ := q.CreateUserGitHub(ctx, otherOrg.ID, fmt.Sprintf("other-%d@example.com", time.Now().UnixNano()), "Other", time.Now().UnixNano(), "other", "")
	_ = q.CreateMembership(ctx, other.ID, otherOrg.ID, "owner")
	_ = q.UpsertIdentityDetails(ctx, other.ID, "workos", "other-"+other.ID, other.Email, true)

	raw, hash, _ := auth.GenerateRefreshToken()
	if _, err := q.CreateInvitation(ctx, targetOrg.ID, inviteeEmail, "member", inviter.ID, hash, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	router := handler.NewRouter(&handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}})
	accept := func(userID, orgID, email, token string) *httptest.ResponseRecorder {
		access, _ := auth.SignAccessToken([]byte(authTestJWTSecret), userID, orgID, email)
		body, _ := json.Marshal(map[string]string{"token": token})
		request := httptest.NewRequest(http.MethodPost, "/api/v1/invitations/accept", bytes.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+access)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	if response := accept(other.ID, otherOrg.ID, other.Email, raw); response.Code != http.StatusBadRequest {
		t.Fatalf("mismatched email status=%d body=%s", response.Code, response.Body.String())
	}
	if response := accept(invitee.ID, personalOrg.ID, invitee.Email, raw); response.Code != http.StatusOK {
		t.Fatalf("accept status=%d body=%s", response.Code, response.Body.String())
	}
	role, err := q.GetMembership(ctx, invitee.ID, targetOrg.ID)
	if err != nil || role != "member" {
		t.Fatalf("accepted membership role=%q err=%v", role, err)
	}
	if response := accept(invitee.ID, personalOrg.ID, invitee.Email, raw); response.Code != http.StatusBadRequest {
		t.Fatalf("replay status=%d body=%s", response.Code, response.Body.String())
	}

	expiredRaw, expiredHash, _ := auth.GenerateRefreshToken()
	if _, err := q.CreateInvitation(ctx, targetOrg.ID, invitee.Email, "member", inviter.ID, expiredHash, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if response := accept(invitee.ID, personalOrg.ID, invitee.Email, expiredRaw); response.Code != http.StatusBadRequest {
		t.Fatalf("expired status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestInvitationAdminRoutesRejectMember(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, _ := q.CreateOrg(ctx, "invite-role")
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	user, _ := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("invite-member-%d@example.com", time.Now().UnixNano()), "Member", time.Now().UnixNano(), "member", "")
	_ = q.CreateMembership(ctx, user.ID, org.ID, "member")
	access, _ := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, org.ID, user.Email)
	router := handler.NewRouter(&handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}})
	body := bytes.NewBufferString(`{"email":"new@example.com","role":"member"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/invitations", body)
	request.Header.Set("Authorization", "Bearer "+access)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("member create status=%d body=%s", response.Code, response.Body.String())
	}
}

// An admin must not be able to grant a role above their own. Without the role
// ceiling an admin can invite an address they control as owner, accept it, and
// seize the organization.
func TestInvitationRoleCannotExceedInviterRole(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	org, _ := q.CreateOrg(ctx, "invite-ceiling")
	t.Cleanup(func() { cleanupTenantHandler(t, pool, org.ID) })
	admin, _ := q.CreateUserGitHub(ctx, org.ID, fmt.Sprintf("invite-admin-%d@example.com", time.Now().UnixNano()), "Admin", time.Now().UnixNano(), "admin", "")
	_ = q.CreateMembership(ctx, admin.ID, org.ID, "admin")
	access, _ := auth.SignAccessToken([]byte(authTestJWTSecret), admin.ID, org.ID, admin.Email)
	router := handler.NewRouter(&handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}})

	invite := func(role string) int {
		body := bytes.NewBufferString(fmt.Sprintf(`{"email":"grant-%d@example.com","role":%q}`, time.Now().UnixNano(), role))
		request := httptest.NewRequest(http.MethodPost, "/api/v1/invitations", body)
		request.Header.Set("Authorization", "Bearer "+access)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response.Code
	}

	if code := invite("owner"); code != http.StatusBadRequest {
		t.Fatalf("admin inviting owner status=%d, want 400", code)
	}
	if code := invite("admin"); code != http.StatusCreated {
		t.Fatalf("admin inviting admin status=%d, want 201", code)
	}
	if code := invite("member"); code != http.StatusCreated {
		t.Fatalf("admin inviting member status=%d, want 201", code)
	}
}
