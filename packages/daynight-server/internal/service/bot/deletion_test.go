package bot

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type deletionScope struct {
	store.SessionScope
	dao *deletionDAO
	bot *deletionBotDAO
}

func (s deletionScope) SessionDAO() store.SessionDAO { return s.dao }
func (s deletionScope) BotDAO() store.BotWriteDAO    { return s.bot }

type deletionDAO struct {
	store.SessionDAO
	calls     *[]string
	revokeErr error
}

func (d *deletionDAO) LockCredential(context.Context, model.Principal, time.Time) error {
	*d.calls = append(*d.calls, "credential")
	return nil
}
func (d *deletionDAO) LockBotSessions(context.Context, string) ([]store.BotSession, error) {
	*d.calls = append(*d.calls, "sessions")
	return []store.BotSession{{ID: "session"}}, nil
}
func (d *deletionDAO) RevokeBotSessions(context.Context, string) error {
	*d.calls = append(*d.calls, "revoke")
	return d.revokeErr
}

type deletionBotDAO struct {
	store.BotWriteDAO
	calls *[]string
	bot   model.Bot
}

func (d *deletionBotDAO) Bot(context.Context, string) (model.Bot, error) {
	*d.calls = append(*d.calls, "bot")
	out := d.bot
	if out.Deletion != nil {
		copy := *out.Deletion
		out.Deletion = &copy
	}
	return out, nil
}
func (d *deletionBotDAO) SaveBotDeletion(_ context.Context, _ string, value *model.BotDeletion) (model.Bot, error) {
	*d.calls = append(*d.calls, "barrier")
	out := d.bot
	out.Deletion = value
	return out, nil
}

type deletionWriter struct {
	t             *testing.T
	ctx           context.Context
	callbackError callbackExpectation
	scope         deletionScope
	outcome       store.TransactionOutcome
	err           error
}

func (w deletionWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	identical(w.t, ctx, w.ctx)
	actual := fn(w.scope)
	w.callbackError.check(w.t, actual)
	return store.Completion{Outcome: w.outcome}, w.err
}

type discardedSessions struct{ ids []string }

func (d *discardedSessions) DiscardBotSession(id string) { d.ids = append(d.ids, id) }

func TestDeletionPublishesRevocationOnlyForCommittedOutcome(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			var calls []string
			p := model.Principal{Kind: model.PATCredential, UserID: "owner"}
			id := "5f80e445-5595-4d89-a209-0f868b8dd10c"
			request := store.DeleteBot{Version: 1, DeletionID: "3469e571-cc04-45c1-9b73-796d0c85fabe"}
			dao := &deletionDAO{calls: &calls}
			bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: p.UserID, Version: 1}}
			cleanupErr := errors.New("cleanup failed")
			live := &discardedSessions{}
			s := NewDeletions(deletionWriter{t: t, ctx: context.Background(), scope: deletionScope{dao: dao, bot: bots}, outcome: outcome, err: cleanupErr}, nil, live)
			bindDeletionFacts(t, s, bots, p, bots.bot, request, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "request": 1, "save": 1}})
			_, err := s.DeleteBot(context.Background(), p, id, request)
			if !errors.Is(err, cleanupErr) {
				t.Fatalf("cleanup error lost: %v", err)
			}
			if !reflect.DeepEqual(calls, []string{"credential", "bot", "sessions", "revoke", "barrier", "credential"}) {
				t.Fatalf("lock and barrier order: %v", calls)
			}
			if outcome == store.TransactionCommitted && !reflect.DeepEqual(live.ids, []string{"session"}) {
				t.Fatalf("committed barrier did not revoke live state: %v", live.ids)
			}
			if outcome != store.TransactionCommitted && len(live.ids) != 0 {
				t.Fatalf("unconfirmed barrier revoked live state: %v", live.ids)
			}
		})
	}
}

func TestDeletionChecksExhaustionAfterSessionRevocation(t *testing.T) {
	var calls []string
	cause := errors.New("revocation failed")
	p := model.Principal{Kind: model.PATCredential, UserID: "owner"}
	id := "5f80e445-5595-4d89-a209-0f868b8dd10c"
	request := store.DeleteBot{Version: math.MaxInt64, DeletionID: "3469e571-cc04-45c1-9b73-796d0c85fabe"}
	dao := &deletionDAO{calls: &calls, revokeErr: cause}
	bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: p.UserID, Version: math.MaxInt64}}
	s := NewDeletions(deletionWriter{t: t, ctx: context.Background(), scope: deletionScope{dao: dao, bot: bots}, outcome: store.TransactionNotCommitted, callbackError: callbackCause(cause), err: cause}, nil, &discardedSessions{})
	bindDeletionFacts(t, s, bots, p, bots.bot, request, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "request": 1}})
	_, err := s.DeleteBot(context.Background(), p, id, request)
	if !errors.Is(err, cause) || !reflect.DeepEqual(calls, []string{"credential", "bot", "sessions", "revoke"}) {
		t.Fatalf("revocation failure must precede exhaustion: %v, %v", err, calls)
	}
	calls = nil
	dao.revokeErr = nil
	exhausted := &model.Fault{Code: "version_exhausted", Message: "exhausted"}
	s.writer = deletionWriter{t: t, ctx: context.Background(), scope: deletionScope{dao: dao, bot: bots}, outcome: store.TransactionNotCommitted, callbackError: callbackCause(exhausted), err: exhausted}
	bindDeletionFacts(t, s, bots, p, bots.bot, request, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "request": 1, "save": 1}, saveError: exhausted})
	_, err = s.DeleteBot(context.Background(), p, id, request)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_exhausted" || !reflect.DeepEqual(calls, []string{"credential", "bot", "sessions", "revoke"}) {
		t.Fatalf("exhaustion must stop before saving barrier: %v, %v", err, calls)
	}
}

func TestDeletionRequiresConfirmedCommitForResultAndRevocation(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown, ""} {
		t.Run(string(outcome), func(t *testing.T) {
			var calls []string
			p := model.Principal{Kind: model.PATCredential, UserID: "owner"}
			id := "5f80e445-5595-4d89-a209-0f868b8dd10c"
			request := store.DeleteBot{Version: 1, DeletionID: "3469e571-cc04-45c1-9b73-796d0c85fabe"}
			dao := &deletionDAO{calls: &calls}
			bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: p.UserID, Version: 1}}
			live := &discardedSessions{}
			s := NewDeletions(deletionWriter{t: t, ctx: context.Background(), scope: deletionScope{dao: dao, bot: bots}, outcome: outcome}, nil, live)
			bindDeletionFacts(t, s, bots, p, bots.bot, request, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "request": 1, "save": 1}})
			result, err := s.DeleteBot(context.Background(), p, id, request)
			if outcome == store.TransactionCommitted {
				if err != nil || result.Deletion == nil || !reflect.DeepEqual(live.ids, []string{"session"}) {
					t.Fatalf("committed result and revocation: %+v %v %v", result, live.ids, err)
				}
			} else if err == nil || !reflect.DeepEqual(result, model.Bot{}) || len(live.ids) != 0 {
				t.Fatalf("unconfirmed result or revocation: %+v %v %v", result, live.ids, err)
			}
		})
	}
}

type cleanupFailureWriter struct {
	t     *testing.T
	scope deletionScope
	calls int
	err   error
}

func (w *cleanupFailureWriter) WriteSession(_ context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	w.calls++
	if w.calls == 2 {
		return store.Completion{Outcome: store.TransactionNotCommitted}, w.err
	}
	if w.calls != 1 {
		w.t.Fatal("unexpected cleanup scope")
	}
	callbackCause(nil).check(w.t, fn(w.scope))
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestDeletionCleanupFailureRetainsCommittedBarrier(t *testing.T) {
	var calls []string
	principal := model.Principal{Kind: model.PATCredential, UserID: "owner"}
	id := "5f80e445-5595-4d89-a209-0f868b8dd10c"
	request := store.DeleteBot{Version: 1, DeletionID: "3469e571-cc04-45c1-9b73-796d0c85fabe"}
	bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: principal.UserID, Version: 2,
		Deletion: &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version,
			WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}}}
	cause := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("cleanup failed")}
	writer := &cleanupFailureWriter{t: t, scope: deletionScope{dao: &deletionDAO{calls: &calls}, bot: bots}, err: cause}
	svc := NewDeletions(writer, nil, &discardedSessions{})
	bindDeletionFacts(t, svc, bots, principal, bots.bot, request, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "request": 1}, replay: true})
	_, err := svc.DeleteBot(context.Background(), principal, id, request)
	var failure *DeletionCleanupError
	if !errors.As(err, &failure) || !errors.Is(err, cause) || writer.calls != 2 {
		t.Fatalf("cleanup failure lost barrier or cause: %v, calls=%d", err, writer.calls)
	}
	if got, want := failure.Error(), "bot deletion cleanup: "+cause.Error(); got != want {
		t.Fatalf("cleanup error message: got %q, want %q", got, want)
	}
}

func TestDeletionReceiptDigestPreservesEncodedBytes(t *testing.T) {
	var calls []string
	p := model.Principal{Kind: model.PATCredential, UserID: "owner"}
	id := "5f80e445-5595-4d89-a209-0f868b8dd10c"
	workerID := "d5eb86fa-c88f-405a-8851-3d371a7cc27e"
	deletionID := "3469e571-cc04-45c1-9b73-796d0c85fabe"
	dao := &deletionDAO{calls: &calls}
	bots := &deletionBotDAO{calls: &calls, bot: model.Bot{ID: id, OwnerUserID: p.UserID, WorkerID: workerID, Version: 1, Deletion: &model.BotDeletion{DeletionID: deletionID, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "completed"}}}}
	s := NewDeletions(deletionWriter{t: t, ctx: context.Background(), scope: deletionScope{dao: dao, bot: bots}, outcome: store.TransactionCommitted}, nil, &discardedSessions{})
	receipt := BotDeletionReceipt{DeletionID: deletionID, Result: model.BotCleanupResult{State: "completed"}}
	bindDeletionFacts(t, s, bots, p, bots.bot, store.DeleteBot{DeletionID: deletionID}, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "worker": 1, "save": 1}, workerChange: true, needsProof: true, receipt: &receipt})
	got, err := s.CompleteBotDeletion(context.Background(), p, workerID, id, receipt)
	if err != nil {
		t.Fatal(err)
	}
	const want = "c1175eaf2e9679c1a507008bf7c5bc07ab8ab41451e9d1af06a04ee40cfa59eb"
	if got.Deletion.ReceiptDigest != want {
		t.Fatalf("digest = %q, want %q", got.Deletion.ReceiptDigest, want)
	}
	bots.bot = got
	bindDeletionFacts(t, s, bots, p, bots.bot, store.DeleteBot{DeletionID: deletionID}, deletionFacts{ctx: context.Background(), calls: map[string]int{"owner": 1, "worker": 1}, receipt: &receipt})
	if _, err = s.CompleteBotDeletion(context.Background(), p, workerID, id, receipt); err != nil {
		t.Fatalf("receipt replay: %v", err)
	}
}
