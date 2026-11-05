package model

import (
	"errors"
	"strings"
	"testing"
)

func TestPrincipalStructureValidation(t *testing.T) {
	id := "f47ac10b-58cc-11cf-a447-001122334455"
	for _, kind := range []CredentialKind{SessionCredential, PATCredential} {
		if err := RequirePrincipal(Principal{Kind: kind, UserID: strings.ToUpper(id), CredentialID: id}); err != nil {
			t.Fatalf("valid principal: %v", err)
		}
	}
	for _, principal := range []Principal{{}, {Kind: SessionCredential, UserID: id, CredentialID: "bad"}, {Kind: PATCredential, UserID: "bad", CredentialID: id}} {
		err := RequirePrincipal(principal)
		var fault *Fault
		if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
			t.Fatalf("invalid principal: %v", err)
		}
	}
}
