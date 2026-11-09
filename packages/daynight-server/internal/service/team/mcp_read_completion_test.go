package team

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpReadCompletion struct {
	store.SnapshotScope
	store.TeamReader
	t       *testing.T
	ctx     context.Context
	pending []string
	failure error
	calls   int
}

func (s *mcpReadCompletion) call(ctx context.Context, method string) {
	if ctx != s.ctx || len(s.pending) == 0 || s.pending[0] != method {
		s.t.Fatalf("unexpected %s; pending %v", method, s.pending)
	}
	s.pending = s.pending[1:]
}
func (s *mcpReadCompletion) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.calls++
	if ctx != s.ctx || s.calls != 1 {
		s.t.Fatal("incorrect read snapshot invocation")
	}
	if err := operation(s); err != nil {
		s.t.Fatalf("unexpected read callback failure: %v", err)
	}
	if len(s.pending) != 0 {
		s.t.Errorf("unconsumed read plan: %v", s.pending)
	}
	return s.failure
}
func (s *mcpReadCompletion) TeamDAO() store.TeamReader { return s }
func (s *mcpReadCompletion) TeamsBounded(ctx context.Context, user string, page store.Page, max int) (store.TeamPage, error) {
	s.call(ctx, "TeamsBounded")
	if user != mcpAdmissionUser || !reflect.DeepEqual(page, store.Page{Limit: 1}) || max != 4<<20 {
		s.t.Errorf("Team list query %s %+v %d", user, page, max)
	}
	return store.TeamPage{Items: []model.Team{}}, nil
}
func (s *mcpReadCompletion) TeamBounded(ctx context.Context, user, id string, max int) (model.Team, bool, error) {
	s.call(ctx, "TeamBounded")
	if user != mcpAdmissionUser || id != mcpAdmissionTeam || max != 1<<20 {
		s.t.Errorf("Team read %s %s %d", user, id, max)
	}
	return model.Team{TeamRef: model.TeamRef{ID: id}}, false, nil
}
func (s *mcpReadCompletion) TeamAccess(ctx context.Context, user, id string) error {
	s.call(ctx, "TeamAccess")
	if user != mcpAdmissionUser || id != mcpAdmissionTeam {
		s.t.Errorf("Team access %s %s", user, id)
	}
	return nil
}
func (s *mcpReadCompletion) TeamMembersPage(ctx context.Context, id string, page store.Page) (store.TeamMemberPage, error) {
	s.call(ctx, "TeamMembersPage")
	if id != mcpAdmissionTeam || !reflect.DeepEqual(page, store.Page{Limit: 1}) {
		s.t.Errorf("member query %s %+v", id, page)
	}
	return store.TeamMemberPage{Items: []model.TeamMemberProfile{}}, nil
}

func TestMCPTeamReadsDiscardResultsAfterSnapshotCompletionFailure(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: mcpAdmissionUser, CredentialID: "44444444-4444-4444-8444-444444444444"}
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted, store.TransactionCommitted} {
		for _, method := range []string{"ListAdmitted", "GetBounded", "MembersAdmitted"} {
			t.Run(string(outcome)+"/"+method, func(t *testing.T) {
				failure := &store.TransactionError{Phase: "commit", Outcome: outcome, CommitAttempted: true, Cause: errors.New("snapshot completion failure")}
				snapshot := &mcpReadCompletion{t: t, ctx: t.Context(), failure: failure}
				service := &Teams{reader: snapshot}
				var err error
				switch method {
				case "ListAdmitted":
					snapshot.pending = []string{"TeamsBounded"}
					result, readErr := service.ListAdmitted(t.Context(), principal, model.PageRequest{Limit: 50}, func([]model.Team, *string) error { t.Fatal("empty list measured"); return nil })
					err = readErr
					if result.Items != nil || result.NextCursor != nil {
						t.Errorf("failed Team page exposed data: %+v", result)
					}
				case "GetBounded":
					snapshot.pending = []string{"TeamBounded"}
					result, readErr := service.GetBounded(t.Context(), principal, mcpAdmissionTeam, 1<<20)
					err = readErr
					if !reflect.DeepEqual(result, model.Team{}) {
						t.Errorf("failed Team read exposed data: %+v", result)
					}
				case "MembersAdmitted":
					snapshot.pending = []string{"TeamAccess", "TeamMembersPage"}
					result, readErr := service.MembersAdmitted(t.Context(), principal, mcpAdmissionTeam, model.PageRequest{Limit: 50}, func([]model.TeamMemberProfile, *string) error { t.Fatal("empty member page measured"); return nil })
					err = readErr
					if result.Items != nil || result.NextCursor != nil {
						t.Errorf("failed member page exposed data: %+v", result)
					}
				}
				if err != failure || snapshot.calls != 1 || len(snapshot.pending) != 0 {
					t.Fatalf("completion = %v; snapshots=%d remaining=%v", err, snapshot.calls, snapshot.pending)
				}
			})
		}
	}
}
