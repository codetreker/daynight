package identity

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/google/uuid"
)

func TestCreateScopedPATRechecksExpiryAfterLock(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	deadline := now.Add(30 * time.Second)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	d := &descriptionDAO{fresh: now.Add(time.Minute)}
	result, err := NewIdentity("").CreateScopedPAT(t.Context(), d, d, p, p.UserID, CreatePAT{Name: "test", ExpiresAt: &deadline}, nil, []scopepolicy.ScopeID{"task:read"}, now)
	checkFault(t, err, "invalid_input")
	if result.Secret != "" || d.stored.ScopePolicy == nil {
		t.Fatalf("returned secret or omitted proposed policy: %#v", result)
	}
}
