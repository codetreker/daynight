package identity

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type personalTeamIDDAO interface{ store.IdentityDAO }

type personalTeamIDScope struct {
	store.IdentityScope
	personalTeamIDDAO
	facts     store.PersonalTeamFacts
	lookupErr error
	ctx       context.Context
	userID    string
	calls     int
}

func (s *personalTeamIDScope) IdentityDAO() store.IdentityDAO { return s }
func (s *personalTeamIDScope) IdentityPersonalTeam(ctx context.Context, userID string) (store.PersonalTeamFacts, error) {
	s.ctx, s.userID = ctx, userID
	s.calls++
	return s.facts, s.lookupErr
}

type personalTeamIDWriter struct {
	scope     *personalTeamIDScope
	ctx       context.Context
	calls     int
	committed bool
}

func (w *personalTeamIDWriter) WriteIdentity(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
	w.ctx = ctx
	w.calls++
	if err := operation(w.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	w.committed = true
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestPersonalTeamIDValidatesOwnershipFactsWithinTransaction(t *testing.T) {
	valid := store.PersonalTeamFacts{ID: "personal-team", MemberCount: 1, OwnerAdminCount: 1}
	failure := errors.New("ownership lookup failed")
	for _, tc := range []struct {
		name      string
		facts     store.PersonalTeamFacts
		err       error
		wantID    string
		fault     string
		committed bool
	}{
		{name: "valid owner", facts: valid, wantID: valid.ID, committed: true},
		{name: "missing team", facts: store.PersonalTeamFacts{MemberCount: 1, OwnerAdminCount: 1}},
		{name: "multiple members", facts: store.PersonalTeamFacts{ID: valid.ID, MemberCount: 2, OwnerAdminCount: 1}},
		{name: "missing administrator", facts: store.PersonalTeamFacts{ID: valid.ID, MemberCount: 1, OwnerAdminCount: 0}},
		{name: "missing account", err: model.ErrNotFound, fault: "unauthenticated", committed: true},
		{name: "lookup failure", err: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			scope := &personalTeamIDScope{facts: tc.facts, lookupErr: tc.err}
			writer := &personalTeamIDWriter{scope: scope}
			s := New(writer, nil, "https://example.test/auth/callback")
			ctx := t.Context()
			p := model.Principal{UserID: "account"}
			id, err := s.PersonalTeamID(ctx, p)
			if id != tc.wantID || writer.calls != 1 || scope.calls != 1 || writer.ctx != ctx || scope.ctx != ctx || scope.userID != p.UserID || writer.committed != tc.committed {
				t.Fatalf("id=%q, writer=%#v, scope=%#v", id, writer, scope)
			}
			if tc.fault != "" {
				requireFault(t, err, tc.fault)
				if !errors.Is(err, tc.err) {
					t.Fatalf("lookup cause lost: %v", err)
				}
			} else if tc.err != nil {
				if err != tc.err {
					t.Fatalf("error=%v; want original %v", err, tc.err)
				}
			} else if tc.wantID != "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || err.Error() != "user Personal Team is missing or invalid" {
				t.Fatalf("invalid ownership facts error=%v", err)
			}
		})
	}
}
