package handler

import "testing"

func TestValidOAuthState(t *testing.T) {
	if validOAuthState("", "x") {
		t.Error("empty cookie must fail")
	}
	if validOAuthState("a", "b") {
		t.Error("mismatch must fail")
	}
	if !validOAuthState("same", "same") {
		t.Error("match must pass")
	}
}
