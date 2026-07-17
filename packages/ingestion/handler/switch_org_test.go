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

	"github.com/google/uuid"
	"github.com/opslane/opslane/packages/ingestion/auth"
	"github.com/opslane/opslane/packages/ingestion/handler"
)

func authCookie(t *testing.T, response *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == name {
			return cookie
		}
	}
	t.Fatalf("response did not set %s", name)
	return nil
}

func TestSwitchOrgRotatesAndPinsSession(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	orgA, err := q.CreateOrg(ctx, "switch-a")
	if err != nil {
		t.Fatal(err)
	}
	orgB, err := q.CreateOrg(ctx, "switch-b")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupTenantHandler(t, pool, orgB.ID)
		cleanupTenantHandler(t, pool, orgA.ID)
	})
	user, err := q.CreateUserGitHub(ctx, orgA.ID, fmt.Sprintf("switch-%d@example.com", time.Now().UnixNano()), "Switch", time.Now().UnixNano(), "switch", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, orgA.ID, "owner"); err != nil {
		t.Fatal(err)
	}
	if err := q.CreateMembership(ctx, user.ID, orgB.ID, "member"); err != nil {
		t.Fatal(err)
	}
	access, err := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, orgA.ID, user.Email)
	if err != nil {
		t.Fatal(err)
	}
	oldRefresh, oldHash, err := auth.GenerateRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := q.StoreRefreshToken(ctx, user.ID, oldHash, uuid.NewString(), orgA.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	deps := &handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}}
	router := handler.NewRouter(deps)
	meRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	meRequest.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: access})
	meResponse := httptest.NewRecorder()
	router.ServeHTTP(meResponse, meRequest)
	if meResponse.Code != http.StatusOK {
		t.Fatalf("auth me status=%d body=%s", meResponse.Code, meResponse.Body.String())
	}
	var me struct {
		ActiveOrgID string `json:"active_org_id"`
		Memberships []struct {
			OrgID string `json:"org_id"`
		} `json:"memberships"`
	}
	if err := json.NewDecoder(meResponse.Body).Decode(&me); err != nil || me.ActiveOrgID != orgA.ID || len(me.Memberships) != 2 {
		t.Fatalf("auth me=%+v err=%v", me, err)
	}
	body, _ := json.Marshal(map[string]string{"org_id": orgB.ID})
	request := httptest.NewRequest(http.MethodPost, "/auth/switch-org", bytes.NewReader(body))
	request.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: access})
	request.AddCookie(&http.Cookie{Name: handler.RefreshCookieName, Value: oldRefresh})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("switch status=%d body=%s", response.Code, response.Body.String())
	}
	newAccess := authCookie(t, response, handler.AccessCookieName)
	newRefresh := authCookie(t, response, handler.RefreshCookieName)
	claims, err := auth.ValidateToken([]byte(authTestJWTSecret), newAccess.Value)
	if err != nil || claims.OrgID != orgB.ID {
		t.Fatalf("switched claims=%+v err=%v", claims, err)
	}
	reloaded, err := q.GetUserByID(ctx, user.ID)
	if err != nil || reloaded.OrgID != orgA.ID {
		t.Fatalf("users.org_id changed: user=%+v err=%v", reloaded, err)
	}

	oldBody, _ := json.Marshal(map[string]string{"refresh_token": oldRefresh})
	oldRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", bytes.NewReader(oldBody))
	oldResponse := httptest.NewRecorder()
	router.ServeHTTP(oldResponse, oldRequest)
	if oldResponse.Code != http.StatusUnauthorized {
		t.Fatalf("old refresh status=%d body=%s", oldResponse.Code, oldResponse.Body.String())
	}

	refreshRequest := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	refreshRequest.AddCookie(newRefresh)
	refreshResponse := httptest.NewRecorder()
	router.ServeHTTP(refreshResponse, refreshRequest)
	if refreshResponse.Code != http.StatusOK {
		t.Fatalf("new refresh status=%d body=%s", refreshResponse.Code, refreshResponse.Body.String())
	}
	refreshedAccess := authCookie(t, refreshResponse, handler.AccessCookieName)
	refreshedClaims, err := auth.ValidateToken([]byte(authTestJWTSecret), refreshedAccess.Value)
	if err != nil || refreshedClaims.OrgID != orgB.ID {
		t.Fatalf("refreshed claims=%+v err=%v", refreshedClaims, err)
	}
}

func TestSwitchOrgRejectsNonMemberBeforeConsumingRefresh(t *testing.T) {
	_, q, pool := authTestRouter(t)
	ctx := context.Background()
	orgA, _ := q.CreateOrg(ctx, "switch-member")
	orgB, _ := q.CreateOrg(ctx, "switch-outsider")
	t.Cleanup(func() {
		cleanupTenantHandler(t, pool, orgB.ID)
		cleanupTenantHandler(t, pool, orgA.ID)
	})
	user, _ := q.CreateUserGitHub(ctx, orgA.ID, fmt.Sprintf("outsider-%d@example.com", time.Now().UnixNano()), "Outsider", time.Now().UnixNano(), "outsider", "")
	_ = q.CreateMembership(ctx, user.ID, orgA.ID, "owner")
	access, _ := auth.SignAccessToken([]byte(authTestJWTSecret), user.ID, orgA.ID, user.Email)
	raw, hash, _ := auth.GenerateRefreshToken()
	_ = q.StoreRefreshToken(ctx, user.ID, hash, uuid.NewString(), orgA.ID, time.Now().Add(time.Hour))
	router := handler.NewRouter(&handler.Dependencies{Queries: q, JWTSecret: []byte(authTestJWTSecret), AuthProvider: cloudAuthStub{}})
	body, _ := json.Marshal(map[string]string{"org_id": orgB.ID})
	request := httptest.NewRequest(http.MethodPost, "/auth/switch-org", bytes.NewReader(body))
	request.AddCookie(&http.Cookie{Name: handler.AccessCookieName, Value: access})
	request.AddCookie(&http.Cookie{Name: handler.RefreshCookieName, Value: raw})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	consumedUser, _, _, err := q.ConsumeRefreshToken(ctx, hash)
	if err != nil || consumedUser != user.ID {
		t.Fatalf("refresh was consumed before membership rejection: user=%q err=%v", consumedUser, err)
	}
}
