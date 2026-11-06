package model

import (
	"errors"
	"strings"
	"testing"
)

func TestPrincipalStructureValidation(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	for _, kind := range []CredentialKind{SessionCredential, PATCredential, OAuthCredential} {
		if err := RequirePrincipal(Principal{Kind: kind, UserID: strings.ToUpper(id), CredentialID: id}); err != nil {
			t.Fatalf("valid principal: %v", err)
		}
	}
	for _, principal := range []Principal{{}, {Kind: SessionCredential, UserID: id, CredentialID: "bad"}, {Kind: PATCredential, UserID: "bad", CredentialID: id}, {Kind: OAuthCredential, UserID: "00000000-0000-0000-0000-000000000000", CredentialID: id}, {Kind: OAuthCredential, UserID: id, CredentialID: "00000000-0000-0000-0000-000000000000"}} {
		err := RequirePrincipal(principal)
		var fault *Fault
		if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
			t.Fatalf("invalid principal: %v", err)
		}
	}
}

func TestEqualOptionalComparesPresenceAndValue(t *testing.T) {
	a, same, other := "a", "a", "b"
	for _, test := range []struct {
		left, right *string
		want        bool
	}{
		{nil, nil, true}, {&a, nil, false}, {nil, &a, false}, {&a, &same, true}, {&a, &other, false},
	} {
		if got := EqualOptional(test.left, test.right); got != test.want {
			t.Fatalf("EqualOptional(%v,%v) = %t", test.left, test.right, got)
		}
	}
}

func TestUnauthenticatedPreservesCause(t *testing.T) {
	cause := errors.New("underlying credential failure")
	err := Unauthenticated(cause)
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != "unauthenticated" || fault.Message != "Authentication is required. Please log in again." || !errors.Is(err, cause) {
		t.Fatalf("authentication fault: %#v", err)
	}
	if errors.Unwrap(Unauthenticated(nil)) != nil {
		t.Fatal("unexpected cause")
	}
}
