package identity

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type personalTeamReader struct {
	store.IdentityDAO
	facts  store.PersonalTeamFacts
	err    error
	ctx    context.Context
	userID string
}

func (r *personalTeamReader) IdentityPersonalTeam(ctx context.Context, userID string) (store.PersonalTeamFacts, error) {
	r.ctx, r.userID = ctx, userID
	return r.facts, r.err
}

func TestPersonalTeamReturnsActorFactsAndPreservesLookupFailures(t *testing.T) {
	m := NewIdentity("https://example.test/auth/callback")
	p := model.Principal{UserID: "owner"}
	facts := store.PersonalTeamFacts{ID: "personal-team", MemberCount: 1, OwnerAdminCount: 1}
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "found"},
		{name: "missing", err: fmt.Errorf("lookup: %w", model.ErrNotFound)},
		{name: "database failure", err: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &personalTeamReader{facts: facts, err: tc.err}
			ctx := t.Context()
			got, err := m.PersonalTeam(ctx, r, p)
			if got != facts || r.ctx != ctx || r.userID != p.UserID {
				t.Fatalf("facts=%#v, forwarded context=%v, user=%q", got, r.ctx == ctx, r.userID)
			}
			if errors.Is(tc.err, model.ErrNotFound) {
				checkFault(t, err, "unauthenticated")
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("lookup cause lost: %v", err)
				}
			} else if err != tc.err {
				t.Fatalf("error=%v; want original %v", err, tc.err)
			}
		})
	}
}
