package bot

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDeletionRejectsInvalidIngressBeforeTransaction(t *testing.T) {
	p, bot, request := sessionDeletionProofIdentity()
	writer := sessionDeletionProofWriter{write: func(context.Context, func(store.SessionScope) error) (store.Completion, error) {
		t.Fatal("invalid ingress opened transaction")
		return store.Completion{}, nil
	}}
	s := NewDeletions(writer, nil, nil)
	s.operations = deletionOperations{}
	for _, tc := range []struct {
		id      string
		request store.DeleteBot
	}{{"bad", request}, {bot.ID, store.DeleteBot{Version: 1, DeletionID: "bad"}}, {bot.ID, store.DeleteBot{Version: 0, DeletionID: request.DeletionID}}} {
		_, err := s.DeleteBot(t.Context(), p, tc.id, tc.request)
		requireFault(t, err, "invalid_input")
	}
	for _, tc := range []struct {
		worker, id string
		receipt    BotDeletionReceipt
	}{{"bad", bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}}}, {bot.WorkerID, "bad", BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}}}, {bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: "bad", Result: model.BotCleanupResult{State: "completed"}}}, {bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "pending"}}}, {bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}, Stop: &sp.TestStop{}}}} {
		_, err := s.CompleteBotDeletion(t.Context(), p, tc.worker, tc.id, tc.receipt)
		requireFault(t, err, "invalid_input")
	}
	p.Kind = model.SessionCredential
	_, err := s.CompleteBotDeletion(t.Context(), p, bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}})
	requireFault(t, err, "forbidden")
}
func TestDeletionPropagatesLowerRefusalsAndCleanupReplay(t *testing.T) {
	for _, stage := range []string{"owner", "request", "worker", "server", "completed cleanup"} {
		t.Run(stage, func(t *testing.T) {
			p, bot, request := sessionDeletionProofIdentity()
			cause := &model.Fault{Code: "resource_conflict", Message: "lower refusal"}
			calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 1, "bot": 1})
			dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }}
			bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }}
			outcome := store.TransactionNotCommitted
			var callbackError error = cause
			if stage == "completed cleanup" {
				outcome = store.TransactionCommitted
				callbackError = nil
			}
			s := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, outcome, callbackCause(callbackError), callbackError), nil, &discardedSessions{})
			receipt := BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}}
			facts := deletionFacts{ctx: t.Context(), calls: map[string]int{"owner": 1}}
			switch stage {
			case "owner":
				facts.ownerError = cause
			case "request":
				facts.calls["request"] = 1
				facts.requestError = cause
			case "worker":
				facts.calls["worker"] = 1
				facts.workerError = cause
				facts.receipt = &receipt
			case "server":
				facts.calls["server"] = 1
				facts.serverError = cause
			case "completed cleanup":
				facts.calls["server"] = 1
			}
			bindDeletionFacts(t, s, bots, p, bot, request, facts)
			var got model.Bot
			var err error
			switch stage {
			case "worker":
				got, err = s.CompleteBotDeletion(t.Context(), p, bot.WorkerID, bot.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Result: model.BotCleanupResult{State: "completed"}})
			case "server", "completed cleanup":
				got, err = s.clean(t.Context(), p, bot.ID, request.DeletionID)
			default:
				got, err = s.DeleteBot(t.Context(), p, bot.ID, request)
			}
			if stage == "completed cleanup" {
				same(t, err, nil)
				same(t, got, bot)
			} else {
				if !errors.Is(err, cause) {
					t.Fatalf("lost lower refusal: %v", err)
				}
				same(t, got, model.Bot{})
			}
		})
	}
}
func TestDeletionMissingAndStorageFailuresDoNotBecomeSuccess(t *testing.T) {
	for _, cause := range []error{model.ErrNotFound, errors.New("credential storage unavailable")} {
		t.Run(cause.Error(), func(t *testing.T) {
			p, bot, request := sessionDeletionProofIdentity()
			calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 1})
			dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return cause }}
			callbackError := cause
			expectedCallback := callbackCause(cause)
			if errors.Is(cause, model.ErrNotFound) {
				fault := &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
				callbackError = fault
				expectedCallback = callbackFreshFault(fault)
			}
			svc := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: &sessionDeletionProofBots{calls: calls}}, store.TransactionNotCommitted, expectedCallback, callbackError), nil, &discardedSessions{})
			svc.operations = deletionOperations{}
			got, err := svc.DeleteBot(t.Context(), p, bot.ID, request)
			same(t, got, model.Bot{})
			if errors.Is(cause, model.ErrNotFound) {
				requireFault(t, err, "unauthenticated")
			} else if !errors.Is(err, cause) {
				t.Fatal(err)
			}
		})
	}
}
func TestDeletionReplayRetainsCompleteCommittedReceipt(t *testing.T) {
	p, bot, request := sessionDeletionProofIdentity()
	bot.Deletion = &model.BotDeletion{DeletionID: request.DeletionID, RequestedVersion: request.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}, ReceiptDigest: "original"}
	calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 2, "bot": 1})
	dao := &sessionDeletionProofDAO{calls: calls, credential: func(ctx context.Context, actor model.Principal, now time.Time) error {
		identical(t, ctx, t.Context())
		same(t, actor, p)
		return nil
	}}
	bots := &sessionDeletionProofBots{calls: calls, read: func(ctx context.Context, id string) (model.Bot, error) {
		identical(t, ctx, t.Context())
		same(t, id, bot.ID)
		return bot, nil
	}}
	live := &discardedSessions{}
	s := NewDeletions(sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, store.TransactionCommitted, callbackCause(nil), nil), nil, live)
	bindDeletionFacts(t, s, bots, p, bot, request, deletionFacts{ctx: t.Context(), calls: map[string]int{"owner": 1, "request": 1}, replay: true})
	got, err := s.DeleteBot(t.Context(), p, bot.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	same(t, got, bot)
	same(t, len(live.ids), 0)
}
