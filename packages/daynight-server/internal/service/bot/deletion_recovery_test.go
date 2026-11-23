package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func deletionResolutionIdentity() (model.Principal, model.Bot, botcore.ResolveDeletion) {
	p, bot, deletion := sessionDeletionProofIdentity()
	code := botcore.MissingExecutionEvidence
	bot.Deletion = &model.BotDeletion{DeletionID: deletion.DeletionID, RequestedVersion: 1, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: &code}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	return p, bot, botcore.ResolveDeletion{Action: "accept_unverified", Version: bot.Version, DeletionID: deletion.DeletionID, OperationID: uuid.NewString(), AcknowledgeLocalUnverified: true, Reason: "Original local execution evidence is missing."}
}

func TestDeletionResolutionCommitsBeforeRealCleanup(t *testing.T) {
	p, original, input := deletionResolutionIdentity()
	instant := time.Now().UTC()
	decided := original
	d := *original.Deletion
	decided.Deletion = &d
	botcore.ApplyDeletionResolution(&decided, input, nil, instant)
	decided.Version++
	finished := decided
	d2 := *decided.Deletion
	finished.Deletion = &d2
	botcore.CompleteServerCleanup(&finished)
	finished.Version++
	calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 3, "bot": 2, "save": 2, "sessions": 1, "redact": 1})
	read, save, transactions := 0, 0, 0
	dao := &sessionDeletionProofDAO{calls: calls, credential: func(ctx context.Context, got model.Principal, _ time.Time) error {
		identical(t, ctx, t.Context())
		same(t, got, p)
		return nil
	},
		sessions: func(_ context.Context, id string) ([]store.BotSession, error) {
			same(t, id, original.ID)
			if transactions != 2 {
				t.Fatal("cleanup preceded confirmed decision")
			}
			return nil, nil
		},
		redact: func(_ context.Context, id string) error { same(t, id, original.ID); return nil }}
	bots := &sessionDeletionProofBots{calls: calls, read: func(_ context.Context, id string) (model.Bot, error) {
		same(t, id, original.ID)
		read++
		if read == 1 {
			return original, nil
		}
		return decided, nil
	},
		save: func(_ context.Context, id string, value *model.BotDeletion) (model.Bot, error) {
			same(t, id, original.ID)
			save++
			if save == 1 {
				same(t, value, decided.Deletion)
				return decided, nil
			}
			same(t, value, finished.Deletion)
			return finished, nil
		}}
	writer := sessionDeletionProofWriter{write: func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		transactions++
		if err := fn(sessionDeletionProofScope{dao: dao, bots: bots}); err != nil {
			t.Fatal(err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	s := NewDeletions(writer, nil, &discardedSessions{})
	s.now = func() time.Time { return instant }
	result, err := s.ResolveDeletion(t.Context(), p, original.ID, input)
	if err != nil || result.ServerCleanup.State != "completed" || result.WorkerCleanup.State != "failed" || result.Decision == nil || result.Decision.LocalDisposition != "unverified" || result.Version != finished.Version {
		t.Fatalf("result: %+v %v", result, err)
	}
}

func TestDeletionResolutionUnknownCommitDoesNotClean(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		t.Run(string(outcome), func(t *testing.T) {
			p, bot, input := deletionResolutionIdentity()
			calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 2, "bot": 1, "save": 1})
			dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }}
			bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, _ string, d *model.BotDeletion) (model.Bot, error) {
				if d.Recovery == nil {
					t.Fatal("missing proposed decision")
				}
				out := bot
				out.Deletion = d
				return out, nil
			}}
			writer := sessionDeletionProofTransaction(t, t.Context(), sessionDeletionProofScope{dao: dao, bots: bots}, outcome, callbackCause(nil), nil)
			result, err := NewDeletions(writer, nil, nil).ResolveDeletion(t.Context(), p, bot.ID, input)
			if err == nil || !reflect.DeepEqual(result, botcore.DeletionRecovery{}) {
				t.Fatalf("unconfirmed result: %+v %v", result, err)
			}
		})
	}
}

func TestDeletionResolutionReplayAndExpiry(t *testing.T) {
	for _, replay := range []bool{false, true} {
		for _, expired := range []bool{false, true} {
			if !replay && !expired {
				continue
			}
			t.Run(map[bool]string{true: "replay", false: "accept"}[replay]+map[bool]string{true: "expired", false: "valid"}[expired], func(t *testing.T) {
				p, bot, input := deletionResolutionIdentity()
				if replay {
					botcore.ApplyDeletionResolution(&bot, input, nil, time.Now())
					bot.Version++
				}
				expected := map[string]int{"credential": 2, "bot": 1}
				if !replay {
					expected["save"] = 1
				}
				calls := expectSessionDeletionProofCalls(t, expected)
				credentialCalls := 0
				dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error {
					credentialCalls++
					if expired && credentialCalls == 2 {
						return model.ErrNotFound
					}
					return nil
				}}
				bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }, save: func(_ context.Context, _ string, d *model.BotDeletion) (model.Bot, error) {
					out := bot
					out.Deletion = d
					return out, nil
				}}
				writer := sessionDeletionProofWriter{write: func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
					err := fn(sessionDeletionProofScope{dao: dao, bots: bots})
					if expired {
						requireFault(t, err, "unauthenticated")
						return store.Completion{Outcome: store.TransactionNotCommitted}, err
					}
					if err != nil {
						t.Fatal(err)
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				}}
				result, err := NewDeletions(writer, nil, nil).ResolveDeletion(t.Context(), p, bot.ID, input)
				if expired {
					requireFault(t, err, "unauthenticated")
				} else if err != nil || result.Decision == nil {
					t.Fatalf("replay: %+v %v", result, err)
				}
			})
		}
	}
}

func TestDeletionResolutionBindingRetentionAndCleanupFailure(t *testing.T) {
	p, bot, input := deletionResolutionIdentity()
	bound, proof, _ := sessionDeletionProofBound(p, bot, store.DeleteBot{Version: input.Version, DeletionID: input.DeletionID})
	bound.Deletion = bot.Deletion
	// The old proof fixture has no separate Bot execution projection.
	execution := proof.Snapshot.TestExecutionID
	bound.TestExecutionID = &execution
	calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 2, "bot": 1, "stop": 1, "save": 1})
	var proposed model.Bot
	dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }, stop: func(ctx context.Context, session, id, owner string) (store.BotSessionStop, error) {
		identical(t, ctx, t.Context())
		same(t, session, *bound.SessionID)
		same(t, id, bound.ID)
		same(t, owner, p.UserID)
		return proof, nil
	}}
	bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bound, nil }, save: func(_ context.Context, _ string, d *model.BotDeletion) (model.Bot, error) {
		proposed = bound
		proposed.Deletion = d
		proposed.Version++
		return proposed, nil
	}}
	failure := errors.New("cleanup read unavailable")
	writes := 0
	writer := sessionDeletionProofWriter{write: func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		writes++
		if writes == 2 {
			return store.Completion{Outcome: store.TransactionNotCommitted}, failure
		}
		if err := fn(sessionDeletionProofScope{dao: dao, bots: bots}); err != nil {
			t.Fatal(err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	_, err := NewDeletions(writer, nil, &discardedSessions{}).ResolveDeletion(t.Context(), p, bound.ID, input)
	if !errors.Is(err, failure) || proposed.Deletion.Recovery == nil || proposed.Deletion.Recovery.OriginalBinding == nil || proposed.Deletion.Recovery.OriginalBinding.SessionID != *bound.SessionID || proposed.Deletion.WorkerCleanup.State != "failed" {
		t.Fatalf("preserved decision: %+v %v", proposed.Deletion, err)
	}
}

func TestDeletionResolutionScopeRefusalAndInvalidIngress(t *testing.T) {
	p, bot, input := deletionResolutionIdentity()
	noWrite := sessionDeletionProofWriter{write: func(context.Context, func(store.SessionScope) error) (store.Completion, error) {
		t.Fatal("invalid request entered transaction")
		return store.Completion{}, nil
	}}
	_, err := NewDeletions(noWrite, nil, nil).ResolveDeletion(t.Context(), p, "bad", input)
	requireFault(t, err, "invalid_input")
	bad := input
	bad.AcknowledgeLocalUnverified = false
	_, err = NewDeletions(noWrite, nil, nil).ResolveDeletion(t.Context(), p, bot.ID, bad)
	requireFault(t, err, "invalid_input")
	calls := expectSessionDeletionProofCalls(t, map[string]int{"credential": 1, "bot": 1})
	dao := &sessionDeletionProofDAO{calls: calls, credential: func(context.Context, model.Principal, time.Time) error { return nil }}
	bots := &sessionDeletionProofBots{calls: calls, read: func(context.Context, string) (model.Bot, error) { return bot, nil }}
	writer := sessionDeletionProofWriter{write: func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		err := fn(sessionDeletionProofScope{dao: dao, bots: bots})
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}}
	source := &definitionSource{deletion: scopedAuthorization(t, scopepolicy.ScopeID("bot:read"))}
	s, err := NewScopedDeletions(writer, nil, nil, source)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.ResolveDeletion(t.Context(), p, bot.ID, input)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("missing delete scope: %v", err)
	}
}
