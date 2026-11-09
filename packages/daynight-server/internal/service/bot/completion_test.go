package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type completionBotDAO struct {
	store.BotWriteDAO
	bot model.Bot
}

func (d completionBotDAO) Credential(context.Context, model.Principal) error { return nil }
func (d completionBotDAO) LockCreation(context.Context, string) error        { return nil }
func (d completionBotDAO) Bot(context.Context, string) (model.Bot, error)    { return d.bot, nil }

type completionBotScope struct{ dao completionBotDAO }

func (s completionBotScope) BotDAO() store.BotWriteDAO { return s.dao }

type completionBotStore struct {
	dao          completionBotDAO
	completion   store.Completion
	finish       func(error) error
	called       bool
	operationErr error
}

func (s *completionBotStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("unexpected snapshot")
}
func (s *completionBotStore) WriteBot(_ context.Context, operation func(store.BotScope) error) (store.Completion, error) {
	s.called = true
	err := operation(completionBotScope{dao: s.dao})
	s.operationErr = err
	return s.completion, s.finish(err)
}

func TestBotWriteCompletionControlsVisibleResults(t *testing.T) {
	ctx := context.Background()
	principal := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	input := botcore.CreateBot{ID: uuid.NewString(), Name: "Bot"}
	_, fingerprint, err := botcore.NormalizeBotRequest(input)
	if err != nil {
		t.Fatal(err)
	}
	initial := model.Bot{ID: input.ID, OwnerUserID: principal.UserID, Name: input.Name, Version: 1, RequestFingerprint: fingerprint}
	cleanup := errors.New("cleanup failed")
	commit := errors.New("commit outcome unknown")
	for _, operation := range []string{"create"} {
		for _, tc := range []struct {
			name       string
			outcome    store.TransactionOutcome
			foreign    bool
			finish     func(error) error
			wantFault  bool
			wantCause  error
			wantResult bool
		}{
			{"committed", store.TransactionCommitted, false, func(err error) error { return err }, false, nil, true},
			{"missing outcome", "", false, func(err error) error { return err }, false, nil, false},
			{"unknown without error", store.TransactionUnknown, false, func(err error) error { return err }, false, nil, false},
			{"not committed without error", store.TransactionNotCommitted, false, func(err error) error { return err }, false, nil, false},
			{"commit failure", store.TransactionUnknown, false, func(err error) error {
				if err != nil {
					t.Fatalf("unexpected operation error: %v", err)
				}
				return &store.TransactionError{Phase: "commit", Cause: commit, Outcome: store.TransactionUnknown, CommitAttempted: true}
			}, false, commit, false},
			{"confirmed refusal", store.TransactionNotCommitted, true, func(err error) error {
				return &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
			}, true, nil, false},
			{"refusal with cleanup failure", store.TransactionUnknown, true, func(err error) error {
				return &store.TransactionError{Phase: "operation", Cause: errors.Join(err, cleanup), Outcome: store.TransactionUnknown, CleanupFailed: true}
			}, false, cleanup, false},
			{"refusal with unknown outcome", store.TransactionUnknown, true, func(err error) error {
				return &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionUnknown}
			}, false, nil, false},
		} {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				bot := initial
				if tc.foreign {
					bot.OwnerUserID = uuid.NewString()
				}
				db := &completionBotStore{dao: completionBotDAO{bot: bot}, completion: store.Completion{Outcome: tc.outcome}, finish: tc.finish}
				service := New(db)
				got, err := service.Create(ctx, principal, input)
				if !db.called {
					t.Fatal("writer was not called")
				}
				if tc.foreign {
					var fault *model.Fault
					if !errors.As(db.operationErr, &fault) || fault.Code != "forbidden" {
						t.Fatalf("expected operation refusal, got %v", db.operationErr)
					}
				} else if db.operationErr != nil {
					t.Fatalf("unexpected operation failure: %v", db.operationErr)
				}
				if tc.wantResult {
					if err != nil || got.ID != input.ID {
						t.Fatalf("committed result: %+v %v", got, err)
					}
					return
				}
				if !reflect.DeepEqual(got, model.Bot{}) {
					t.Fatalf("unconfirmed write exposed result: %+v", got)
				}
				if tc.wantFault {
					fault, ok := err.(*model.Fault)
					if !ok || fault.Code != "forbidden" {
						t.Fatalf("expected confirmed refusal, got %T %v", err, err)
					}
				} else {
					failure, ok := err.(*model.BotOperationError)
					if !ok || failure.Operation != operation {
						t.Fatalf("expected operational error, got %T %v", err, err)
					}
				}
				if tc.wantCause != nil && !errors.Is(err, tc.wantCause) {
					t.Fatalf("lost cause %v: %v", tc.wantCause, err)
				}
			})
		}
	}
}
