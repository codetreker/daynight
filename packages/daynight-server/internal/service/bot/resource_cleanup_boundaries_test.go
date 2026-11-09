package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type resourceBoundaryDAO struct {
	*deletionDAO
	store.SessionResourceDAO
	session store.BotSession
	point   string
	cause   error
}

func (d *resourceBoundaryDAO) LockBotSessions(context.Context, string) ([]store.BotSession, error) {
	return []store.BotSession{d.session}, nil
}
func (d *resourceBoundaryDAO) SessionResourceUsage(context.Context, string) (store.SessionResourceUsage, error) {
	if d.point == "usage" {
		return store.SessionResourceUsage{}, d.cause
	}
	return store.SessionResourceUsage{}, nil
}
func (d *resourceBoundaryDAO) BeginSessionResourceDeletion(context.Context, string) (int64, error) {
	if d.point == "begin" {
		return 0, d.cause
	}
	return 1, nil
}
func (d *resourceBoundaryDAO) ListSessionResourceLeases(context.Context, string) ([]store.SessionResourceLease, error) {
	if d.point == "leases" {
		return nil, d.cause
	}
	return []store.SessionResourceLease{{ID: "original-lease"}}, nil
}
func (d *resourceBoundaryDAO) ReleaseSessionResourceLease(context.Context, string, string) error {
	if d.point == "release" {
		return d.cause
	}
	return nil
}

type resourceBoundaryScope struct {
	store.SessionScope
	dao store.SessionDAO
	bot store.BotWriteDAO
}

func (s resourceBoundaryScope) SessionDAO() store.SessionDAO { return s.dao }
func (s resourceBoundaryScope) BotDAO() store.BotWriteDAO    { return s.bot }

type resourceBoundaryWriter struct {
	t        *testing.T
	scope    resourceBoundaryScope
	calls    int
	outcomes []store.TransactionOutcome
}

func (w *resourceBoundaryWriter) WriteSession(_ context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	w.calls++
	if w.calls > len(w.outcomes) {
		w.t.Fatal("unexpected cleanup transaction")
	}
	e := fn(w.scope)
	return store.Completion{Outcome: w.outcomes[w.calls-1]}, e
}

func resourceCleanupCoreFixture(t *testing.T, bots *deletionBotDAO, p model.Principal, id, deletion string) resourceCleanupOperations {
	t.Helper()
	return resourceCleanupOperations{
		requireOwner: func(bot model.Bot, principal model.Principal) error {
			*bots.calls = append(*bots.calls, "owner-operation")
			if bot.ID != id || principal != p {
				t.Fatal("core ownership input changed")
			}
			return nil
		},
		prepare: func(bot model.Bot, original string) (bool, error) {
			*bots.calls = append(*bots.calls, "prepare-operation")
			if bot.ID != id || original != deletion {
				t.Fatal("core preparation input changed")
			}
			return true, nil
		},
		fail: func(*model.Bot, string) (bool, error) { t.Fatal("unconfigured failure operation"); return false, nil },
		save: func(context.Context, store.BotWriteDAO, model.Bot) (model.Bot, error) {
			t.Fatal("unconfigured save operation")
			return model.Bot{}, nil
		},
	}
}

type resourceBoundaryLive struct {
	cause error
	calls int
}

func (l *resourceBoundaryLive) CancelSessionMedia(context.Context, string) error {
	l.calls++
	return l.cause
}

type resourceBoundaryStorage struct {
	*local.Storage
	point string
	cause error
}

func (s resourceBoundaryStorage) DeleteSessionResources(ctx context.Context, n sessionresource.Namespace) error {
	if s.point == "resources" {
		return s.cause
	}
	return s.Storage.DeleteSessionResources(ctx, n)
}
func (s resourceBoundaryStorage) DeleteSessionArchives(ctx context.Context, n sessionarchive.Namespace) error {
	if s.point == "archives" {
		return s.cause
	}
	return s.Storage.DeleteSessionArchives(ctx, n)
}

func TestBotResourceCleanupRetainsBarrierAfterFailedLeaseAndSweepProofs(t *testing.T) {
	for _, kind := range []string{"scope", "usage", "begin", "missing storage", "cancel", "leases", "lease observation unknown", "release", "lease removal unknown", "resources", "archives"} {
		t.Run(kind, func(t *testing.T) {
			var calls []string
			p := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString()}
			deletion := uuid.NewString()
			id := uuid.NewString()
			bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: p.UserID, Deletion: &model.BotDeletion{DeletionID: deletion, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}}}
			cause := errors.New("original resource cleanup unavailable")
			d := &resourceBoundaryDAO{deletionDAO: &deletionDAO{calls: &calls}, session: store.BotSession{ID: uuid.NewString(), Owner: p.UserID, Scope: "test", Backend: "web"}, cause: cause}
			writer := &resourceBoundaryWriter{t: t, scope: resourceBoundaryScope{dao: d, bot: bots}, outcomes: []store.TransactionOutcome{store.TransactionCommitted, store.TransactionCommitted, store.TransactionCommitted}}
			operations := resourceCleanupCoreFixture(t, bots, p, id, deletion)
			files, e := local.New(t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			t.Cleanup(func() { _ = files.Close() })
			var storage filestorage.Storage = resourceBoundaryStorage{Storage: files, point: kind, cause: cause}
			live := &resourceBoundaryLive{}
			switch kind {
			case "scope":
				d.session.Owner = uuid.NewString()
				writer.outcomes[0] = store.TransactionNotCommitted
			case "usage", "begin", "leases", "release":
				d.point = kind
				at := 0
				if kind == "leases" {
					at = 1
				}
				if kind == "release" {
					at = 2
				}
				writer.outcomes[at] = store.TransactionNotCommitted
			case "missing storage":
				storage = nil
			case "cancel":
				live.cause = cause
			case "lease observation unknown":
				writer.outcomes[1] = store.TransactionUnknown
			case "lease removal unknown":
				writer.outcomes[2] = store.TransactionUnknown
			}
			s := NewDeletions(writer, storage, nil)
			e = s.cleanSessionResourcesUsing(t.Context(), p, id, deletion, live, operations)
			if e == nil {
				t.Fatal("failed resource cleanup reported success", kind)
			}
			if d.point != "" || kind == "cancel" || kind == "resources" || kind == "archives" {
				if !errors.Is(e, cause) {
					t.Fatal("cleanup cause hidden", e)
				}
			}
			if kind == "cancel" || kind == "resources" || kind == "archives" {
				var physical *resourceCleanupFailure
				if !errors.As(e, &physical) || physical.Error() != cause.Error() {
					t.Fatal("physical cleanup failure classification lost", e)
				}
			}
			if bots.bot.Deletion.ServerCleanup.State != "pending" {
				t.Fatal("cleanup failure erased retry obligation")
			}
			if !reflect.DeepEqual(calls, []string{"credential", "bot", "owner-operation", "prepare-operation"}) {
				t.Fatal("unexpected lower business operations", calls)
			}
		})
	}
}

func TestBotCleanupFailureCoordinatesCoreResultsAndIndependentCompletion(t *testing.T) {
	for _, kind := range []string{"core no change", "core refusal", "unknown commit", "changed", "save failure"} {
		t.Run(kind, func(t *testing.T) {
			var calls []string
			p := model.Principal{Kind: model.PATCredential, UserID: "owner"}
			deletion := uuid.NewString()
			bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: "bot", OwnerUserID: p.UserID, Deletion: &model.BotDeletion{DeletionID: deletion, ServerCleanup: model.BotCleanupResult{State: "completed"}}}}
			writer := &resourceBoundaryWriter{t: t, scope: resourceBoundaryScope{dao: &deletionDAO{calls: &calls}, bot: bots}, outcomes: []store.TransactionOutcome{store.TransactionCommitted}}
			operations := resourceCleanupCoreFixture(t, bots, p, "bot", deletion)
			cause := errors.New("core cleanup refusal")
			operations.fail = func(bot *model.Bot, original string) (bool, error) {
				calls = append(calls, "fail-operation")
				if bot.ID != "bot" || original != deletion {
					t.Fatal("core failure input changed")
				}
				if kind == "core refusal" {
					return false, cause
				}
				return kind == "changed" || kind == "save failure", nil
			}
			operations.save = func(ctx context.Context, dao store.BotWriteDAO, bot model.Bot) (model.Bot, error) {
				calls = append(calls, "save-operation")
				if ctx != t.Context() || dao != bots || bot.ID != "bot" {
					t.Fatal("core save input changed")
				}
				if kind == "save failure" {
					return model.Bot{}, cause
				}
				return bot, nil
			}
			if kind == "core refusal" || kind == "save failure" {
				writer.outcomes[0] = store.TransactionNotCommitted
			}
			if kind == "unknown commit" {
				writer.outcomes[0] = store.TransactionUnknown
			}
			s := NewDeletions(writer, nil, nil)
			out, e := s.recordCleanupFailureUsing(t.Context(), p, "bot", deletion, operations)
			if kind == "core no change" || kind == "changed" {
				if e != nil || out.Deletion == nil || out.Deletion.ServerCleanup.State != "completed" {
					t.Fatal(out, e)
				}
			} else if e == nil {
				t.Fatal("invalid cleanup failure record succeeded")
			}
			if (kind == "core refusal" || kind == "save failure") && !errors.Is(e, cause) {
				t.Fatal("lower core cause lost", e)
			}
			want := []string{"credential", "bot", "owner-operation", "fail-operation"}
			if kind == "changed" || kind == "save failure" {
				want = append(want, "save-operation")
			}
			if !reflect.DeepEqual(calls, want) {
				t.Fatal("unexpected operation ordering", calls, want)
			}
			if bots.bot.Deletion.ServerCleanup.State != "completed" {
				t.Fatal("concurrent successful cleanup was downgraded")
			}
		})
	}
}
