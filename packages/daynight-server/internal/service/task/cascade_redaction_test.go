package task

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestCascadeIncompatibleWorkerFaultRedaction(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	for _, canRead := range []bool{false, true} {
		scopes := []scopepolicy.ScopeID{"task:status"}
		if canRead {
			scopes = []scopepolicy.ScopeID{"task:read", "task:status"}
		}
		policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
		if err != nil {
			t.Fatal(err)
		}
		ctx := WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
		failure := cancellationFault(&model.Fault{Code: "invalid_transition", Message: "Worker requires a compatible client."}, "private-child")
		var fault *model.Fault
		if !errors.As(redactTaskWriteError(ctx, failure), &fault) || fault.Code != "invalid_transition" || (len(fault.TaskIDs) == 1) != canRead {
			t.Fatalf("read=%v fault=%+v", canRead, fault)
		}
	}
}
