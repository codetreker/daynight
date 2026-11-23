package task

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestReadAuthorizationRequiresIdentityAndScope(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "10000000-0000-4000-8000-000000000002"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
	if err := RequireReadAuthorization(a, p); err != nil {
		t.Fatal(err)
	}
	if err := RequireReadAuthorization(a, p, scopepolicy.ProjectRead); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("full project admission: %v", err)
	}
	p.CredentialID = "10000000-0000-4000-8000-000000000003"
	if err := RequireReadAuthorization(a, p); err == nil {
		t.Fatal("accepted different credential")
	}
	a.Policy = nil
	if err := RequireReadAuthorization(a, a.Principal); err == nil {
		t.Fatal("accepted missing policy")
	}
}

func TestWithoutSessionPropertiesPreservesOrdinaryFieldsAndInput(t *testing.T) {
	input := model.Task{ID: "task", Properties: model.TaskProperties{"worker": json.RawMessage(`{"nativeSessionId":"private"}`), "sessionStartup": json.RawMessage(`{"sessionId":"private"}`), "blocked": json.RawMessage(`true`)}}
	got := WithoutSessionProperties(input)
	if got.ID != input.ID || len(got.Properties) != 1 || string(got.Properties["blocked"]) != "true" || len(input.Properties) != 3 {
		t.Fatalf("projection mutated task content: %#v %#v", got, input)
	}
	v := ScopeUnavailableObservation()
	if v.Observation != "unavailable" || v.Registration != "unknown" || v.Reason != "insufficient_scope" || v.SessionID != nil || v.ObservedAt != nil || v.FreshUntil != nil || v.Send.Allowed != nil || v.Send.Mode != nil {
		t.Fatalf("scope placeholder leaked facts: %#v", v)
	}
}
