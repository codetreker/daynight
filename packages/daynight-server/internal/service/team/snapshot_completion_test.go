package team

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type completionTeamReadPlan struct {
	store.TeamWriter
	store.SnapshotScope
	store.TeamReader
	t          *testing.T
	ctx        context.Context
	principal  model.Principal
	team       string
	invitation []byte
	pending    []string
	completion error
	cancel     context.CancelFunc
	snapshots  int
}

func (s *completionTeamReadPlan) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.snapshots++
	if ctx != s.ctx || s.snapshots != 1 {
		s.t.Fatal("Team snapshot changed context or repeated")
	}
	if err := operation(s); err != nil {
		s.t.Fatalf("Team callback did not stage its refusal: %v", err)
	}
	if s.cancel != nil {
		s.cancel()
	}
	return s.completion
}
func (s *completionTeamReadPlan) TeamDAO() store.TeamReader { return s }
func (s *completionTeamReadPlan) take(ctx context.Context, name string) {
	s.t.Helper()
	if ctx != s.ctx || len(s.pending) == 0 || s.pending[0] != name {
		s.t.Fatalf("unexpected Team read %s, pending=%v", name, s.pending)
	}
	s.pending = s.pending[1:]
}
func (s *completionTeamReadPlan) Team(ctx context.Context, user, id string) (model.Team, error) {
	s.take(ctx, "team")
	if user != s.principal.UserID || id != s.team {
		s.t.Fatalf("Team arguments %s/%s", user, id)
	}
	return model.Team{}, model.ErrNotFound
}
func (s *completionTeamReadPlan) TeamInvitation(ctx context.Context, hash []byte) (model.TeamInvitation, error) {
	s.take(ctx, "invitation")
	if !reflect.DeepEqual(hash, s.invitation) {
		s.t.Fatal("Team invitation hash changed")
	}
	return model.TeamInvitation{}, model.ErrNotFound
}

func TestTeamMissingReadsRetainSnapshotCompletionFailure(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "ab000000-0000-4000-8000-000000000001", CredentialID: "ab000000-0000-4000-8000-000000000002"}
	missing := "cd000000-0000-4000-8000-000000000099"
	invitation := secretutil.Random("dnteam_")
	for _, method := range []string{"Get", "Members", "InspectInvitation"} {
		t.Run(method, func(t *testing.T) {
			for _, failCompletion := range []bool{false, true} {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				db := &completionTeamReadPlan{t: t, ctx: ctx, principal: p, team: missing, invitation: secretutil.Hash(invitation), pending: []string{"team"}}
				if method == "InspectInvitation" {
					db.pending = []string{"invitation"}
				}
				t.Cleanup(func() {
					if db.snapshots != 1 {
						t.Errorf("Team snapshots=%d, want 1", db.snapshots)
					}
					if len(db.pending) != 0 {
						t.Errorf("unconsumed Team reads: %v", db.pending)
					}
				})
				failure := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
				if failCompletion {
					db.completion, db.cancel = failure, cancel
				}
				s := NewTeams(db)
				var result any
				var err error
				switch method {
				case "Get":
					result, err = s.Get(ctx, p, missing)
				case "Members":
					result, err = s.Members(ctx, p, missing)
				case "InspectInvitation":
					result, err = s.InspectInvitation(ctx, p, invitation)
				}
				var fault *model.Fault
				if !failCompletion {
					if !errors.As(err, &fault) {
						t.Fatalf("missing Team read did not stage refusal: %v", err)
					}
					continue
				}
				var completion *store.TransactionError
				if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || completion.Outcome != store.TransactionUnknown || !completion.CommitAttempted || errors.As(err, &fault) || !reflect.DeepEqual(result, reflect.Zero(reflect.TypeOf(result)).Interface()) {
					t.Fatalf("completion returned a refusal or partial result: %#v, %v", result, err)
				}
			}
		})
	}
}
