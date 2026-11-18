package session

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/jackc/pgx/v5"
)

type archiveVisibilityContextKey struct{}

type archiveVisibilityDAO struct {
	store.SessionDAO
	t         *testing.T
	ctx       context.Context
	actor     model.Principal
	project   string
	sessionID string
	missing   error
	member    bool
	pending   []string
	cancel    context.CancelCauseFunc
}

func (d *archiveVisibilityDAO) take(ctx context.Context, call string) {
	d.t.Helper()
	if ctx != d.ctx || len(d.pending) == 0 || d.pending[0] != call {
		d.t.Fatalf("unexpected archive preflight call %q: same context=%v pending=%v", call, ctx == d.ctx, d.pending)
	}
	d.pending = d.pending[1:]
}

func (d *archiveVisibilityDAO) ReadCredential(ctx context.Context, actor model.Principal, now time.Time) error {
	d.take(ctx, "credential")
	if actor != d.actor || now.IsZero() {
		d.t.Fatalf("archive credential check: actor=%#v time=%v, want %#v and a time", actor, now, d.actor)
	}
	return nil
}

func (d *archiveVisibilityDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.take(ctx, "project")
	if user != d.actor.UserID || project != d.project {
		d.t.Fatalf("archive Project access: user=%q project=%q, want %q %q", user, project, d.actor.UserID, d.project)
	}
	if d.cancel != nil {
		d.cancel(context.Canceled)
		if !errors.Is(ctx.Err(), context.Canceled) {
			d.t.Fatal("archive preflight context did not observe caller cancellation")
		}
		return model.ProjectAccess{}, ctx.Err()
	}
	if !d.member {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	return model.ProjectAccess{ProjectID: project, UserID: user, Role: model.ProjectAdmin}, nil
}

func (d *archiveVisibilityDAO) ArchiveMetadata(ctx context.Context, id string) (store.ArchiveMetadata, error) {
	d.take(ctx, "metadata")
	if id != d.sessionID {
		d.t.Fatalf("archive metadata Session=%q, want %q", id, d.sessionID)
	}
	return store.ArchiveMetadata{}, d.missing
}

func TestArchivePreflightDoesNotRevealSessionToNonmember(t *testing.T) {
	owner := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	outsider := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000002", CredentialID: "20000000-0000-4000-8000-000000000002"}
	const project = "30000000-0000-4000-8000-000000000001"
	const task = "40000000-0000-4000-8000-000000000001"
	const existing = "50000000-0000-4000-8000-000000000001"
	const absent = "50000000-0000-4000-8000-000000000002"
	for _, test := range []struct {
		name      string
		actor     model.Principal
		sessionID string
		want      string
	}{
		{"nonmember existing", outsider, existing, "forbidden"},
		{"nonmember missing", outsider, absent, "forbidden"},
		{"owner missing", owner, absent, "not_found"},
		{"caller canceled during preflight", owner, absent, "canceled"},
	} {
		t.Run(test.name, func(t *testing.T) {
			visible := context.WithValue(t.Context(), archiveVisibilityContextKey{}, test.name)
			caller, cancel := context.WithCancelCause(visible)
			defer cancel(nil)

			missing := &store.Error{Phase: "read archive metadata", MissingRow: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}
			dao := &archiveVisibilityDAO{
				t: t, actor: test.actor, project: project, sessionID: test.sessionID,
				missing: missing, member: test.actor == owner, pending: []string{"list media leases", "credential", "project"},
			}
			if test.want == "not_found" {
				dao.pending = append(dao.pending, "metadata")
			}
			if test.want == "canceled" {
				dao.cancel = cancel
			}

			writes := 0
			writer := archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				writes++
				switch writes {
				case 1:
					if actual == caller || actual.Value(archiveVisibilityContextKey{}) != test.name || actual.Err() != nil {
						t.Fatal("archive recovery did not receive a live derived caller context")
					}
					dao.ctx = actual
					leases := mediaRecoveryListOnlyDAO{list: func(ctx context.Context) ([]store.SessionResourceLease, error) {
						dao.take(ctx, "list media leases")
						return nil, nil
					}}
					if err := run(mediaRecoveryScope{dao: leases}); err != nil {
						t.Fatalf("list media leases: %v", err)
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				case 2:
					if actual != dao.ctx {
						t.Fatal("archive preflight and recovery used different contexts")
					}
					cause := run(mediaRecoveryScope{dao: dao})
					if cause == nil {
						t.Fatal("archive preflight did not report its refusal or failure")
					}
					outcome := store.TransactionNotCommitted
					return store.Completion{Outcome: outcome}, &store.Error{
						Phase: "write session",
						Cause: &store.TransactionError{Phase: "operation", Outcome: outcome, Cause: cause},
					}
				default:
					t.Fatalf("unexpected archive transaction %d", writes)
					return store.Completion{}, nil
				}
			})
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			archive, err := New(writer, engine).BeginArchive(caller, test.actor, project, task, test.sessionID, core.ArchiveV1Read)
			if archive != nil || writes != 2 || len(dao.pending) != 0 {
				t.Fatalf("archive preflight returned an operation or missed calls: archive=%v writes=%d pending=%v", archive != nil, writes, dao.pending)
			}
			if test.want == "canceled" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("archive cancellation lost its cause: %v", err)
				}
			} else {
				requireServiceError(t, err, test.want)
			}
			if kind := httpx.ErrorKind(err); kind != test.want {
				t.Fatalf("archive error classified as %q, want %q: %v", kind, test.want, err)
			}
			if test.want == "not_found" && (!errors.Is(err, missing) || !errors.Is(err, model.ErrNotFound) || !errors.Is(err, pgx.ErrNoRows)) {
				t.Fatalf("archive missing-row classification lost its causes: %v", err)
			}
			if !errors.Is(dao.ctx.Err(), context.Canceled) {
				t.Fatal("archive preflight did not cancel its derived context")
			}
		})
	}
}

func TestOnlySessionCauseDistinguishesCleanup(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	failure := errors.New("cleanup")
	for _, tc := range []struct {
		name        string
		err, target error
		want        bool
	}{
		{"same", fault, fault, true},
		{"wrapped", fmt.Errorf("wrapped: %w", fault), fault, true},
		{"single join", errors.Join(fault), fault, true},
		{"mixed failure", errors.Join(fault, failure), fault, false},
		{"unrelated", failure, fault, false},
		{"missing row", &store.Error{MissingRow: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}, model.ErrNotFound, true},
		{"missing and cleanup", errors.Join(&store.Error{MissingRow: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}, failure), model.ErrNotFound, false},
		{"database failure", &store.Error{MissingRow: true, DatabaseFailure: true, Cause: errors.Join(model.ErrNotFound, pgx.ErrNoRows)}, model.ErrNotFound, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := onlySessionCause(tc.err, tc.target); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
