package team

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

type scopedHTTPStore struct {
	store.TeamWriter
	store.SnapshotReader
	store.TeamWriteScope
	store.TeamWriteDAO
	team   model.Team
	writes int
}

func (s *scopedHTTPStore) WriteTeam(ctx context.Context, _ string, op func(store.TeamWriteScope) error) (store.Completion, error) {
	if err := op(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s *scopedHTTPStore) TeamDAO() store.TeamWriteDAO                      { return s }
func (s *scopedHTTPStore) Team(context.Context, string) (model.Team, error) { return s.team, nil }
func (s *scopedHTTPStore) Rename(context.Context, string, string) (model.Team, error) {
	s.writes++
	return model.Team{}, nil
}

func TestScopedRenameHTTPRejectsAdminWithoutWriteScope(t *testing.T) {
	const user = "11111111-1111-4111-8111-111111111111"
	const id = "22222222-2222-4222-8222-222222222222"
	name := "Old"
	p := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: "33333333-3333-4333-8333-333333333333"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"team:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
	db := &scopedHTTPStore{team: model.Team{TeamRef: model.TeamRef{ID: id, Kind: "ordinary", Name: &name}, Version: 1, Membership: model.TeamMember{Role: model.ProjectAdmin}}}
	service, err := teamservice.NewScopedTeams(db, func(context.Context, model.Principal) (model.CredentialAuthorization, error) { return auth, nil }, func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error) {
		t.Fatal("unexpected snapshot")
		return model.CredentialAuthorization{}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	h := &teamHandler{teams: service, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/teams/"+id, strings.NewReader(`{"name":"New","version":1,"expectedUserId":"`+user+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("teamId", id)
	w := httptest.NewRecorder()
	h.rename(w, req, p)
	var response api.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusForbidden || response.Error.Code != "forbidden" || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || db.writes != 0 {
		t.Fatalf("status=%d body=%s scope=%q writes=%d", w.Code, w.Body.String(), w.Header().Get("Daynight-Scope-Status"), db.writes)
	}
}
