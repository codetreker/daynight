package github

import (
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type grantWriteWithoutAdmission struct{ store.GitHubGrantWriteDAO }

func TestGrantScopedWriteUsesNarrowFactsAndPreservesRefusals(t *testing.T) {
	actor, teamID, grantID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.PATCredential, UserID: actor, CredentialID: uuid.NewString()}
	facts := store.GitHubGrantFacts{Team: store.GitHubGrantTeam{TeamRef: model.TeamRef{ID: teamID}, Version: 3}, AppVersion: 2, ImpactVersion: 4, IsAdmin: true}
	input := CreateGrantInput{ID: grantID, TeamID: teamID, ExpectedUserID: actor, Version: 2, TeamVersion: 3}
	deny := errors.New("scope denied")
	f := &grantWriteStub{facts: facts}
	if _, err := CreateGrantWithAdmission(t.Context(), f, p, input, func() error { return deny }); !errors.Is(err, deny) || !reflect.DeepEqual(f.steps, []string{"admission"}) {
		t.Fatalf("denial %v %v", err, f.steps)
	}
	f.steps = nil
	f.facts.AppVersion = 1
	if _, err := CreateGrantWithAdmission(t.Context(), f, p, input, func() error { return deny }); err == nil || !reflect.DeepEqual(f.steps, []string{"admission"}) {
		t.Fatalf("version %v %v", err, f.steps)
	} else {
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "version_conflict" {
			t.Fatalf("version priority: %v", err)
		}
	}
	f.facts = facts
	f.steps = nil
	if _, err := CreateGrantWithAdmission(t.Context(), f, p, input, func() error { return nil }); err != nil || !reflect.DeepEqual(f.steps, []string{"admission", "facts", "live", "insert", "impact"}) {
		t.Fatalf("create %v %v", err, f.steps)
	}
	f.steps = nil
	f.current = &store.GitHubTeamGrant{ID: grantID}
	revoke := RevokeGrantInput{ExpectedUserID: actor, Version: 2, ImpactVersion: 4}
	if err := RevokeGrantWithAdmission(t.Context(), f, p, grantID, revoke, func() error { return deny }); !errors.Is(err, deny) || !reflect.DeepEqual(f.steps, []string{"admission", "visible grant"}) {
		t.Fatalf("revoke denial %v %v", err, f.steps)
	}
	f.steps = nil
	if err := RevokeGrantWithAdmission(t.Context(), f, p, grantID, revoke, func() error { return nil }); err != nil || !reflect.DeepEqual(f.steps, []string{"admission", "visible grant", "facts", "grant", "stop", "revoke", "impact"}) {
		t.Fatalf("revoke %v %v", err, f.steps)
	}
	f.steps = nil
	missing := grantWriteWithoutAdmission{f}
	if _, err := CreateGrantWithAdmission(t.Context(), missing, p, input, func() error { return nil }); err == nil || len(f.steps) != 0 {
		t.Fatalf("missing capability %v %v", err, f.steps)
	}
}

var _ store.GitHubGrantWriteAdmissionDAO = (*grantWriteStub)(nil)
