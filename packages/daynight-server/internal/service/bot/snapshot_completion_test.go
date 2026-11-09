package bot

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type botListCompletion struct {
	store.SnapshotScope
	store.BotReader
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	records   store.BotPage
	failure   error
	finish    func()
	calls     []string
}

func (s *botListCompletion) call(ctx context.Context, name string) {
	s.t.Helper()
	if ctx != s.ctx {
		s.t.Errorf("%s replaced the caller context", name)
	}
	s.calls = append(s.calls, name)
}
func (s *botListCompletion) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.call(ctx, "snapshot")
	if err := operation(s); err != nil {
		s.t.Fatalf("normal Bot list callback failed: %v", err)
	}
	s.call(ctx, "completion")
	if s.finish != nil {
		s.finish()
	}
	return s.failure
}
func (s *botListCompletion) WriteBot(context.Context, func(store.BotScope) error) (store.Completion, error) {
	s.t.Error("Bot list attempted a write")
	return store.Completion{}, errors.New("unexpected Bot write")
}
func (s *botListCompletion) CredentialDAO() store.CredentialReader {
	s.calls = append(s.calls, "credentialDAO")
	return s
}
func (s *botListCompletion) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.call(ctx, "credential")
	if principal != s.principal {
		s.t.Errorf("credential principal = %+v, want %+v", principal, s.principal)
	}
	return store.ThreadCredential{}, nil
}
func (s *botListCompletion) BotDAO() store.BotReader {
	s.calls = append(s.calls, "botDAO")
	return s
}
func (s *botListCompletion) Bots(ctx context.Context, user string, worker *string, page store.Page) (store.BotPage, error) {
	s.call(ctx, "bots")
	if user != s.principal.UserID || worker != nil || !reflect.DeepEqual(page, store.Page{Limit: 10}) {
		s.t.Errorf("Bot query = %s/%v %+v", user, worker, page)
	}
	return s.records, nil
}

func TestBotListDiscardsReadResultsAfterSnapshotCompletionFailure(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "confirmed read"
		if failed {
			name = "unknown completion"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
			reader := &botListCompletion{t: t, ctx: ctx, principal: principal, records: store.BotPage{Items: []model.Bot{}}}
			var failure *store.TransactionError
			if failed {
				failure = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
				reader.failure, reader.finish = failure, cancel
			}
			result, err := New(reader).List(ctx, principal, model.PageRequest{Limit: 10})
			if !slices.Equal(reader.calls, []string{"snapshot", "credentialDAO", "credential", "botDAO", "bots", "completion"}) {
				t.Fatalf("Bot list calls = %v", reader.calls)
			}
			if !failed {
				if err != nil || !reflect.DeepEqual(result, botcore.BotPage{Items: []model.Bot{}}) {
					t.Fatalf("confirmed Bot list = %+v, %v", result, err)
				}
				return
			}
			var completion *store.TransactionError
			var refusal *model.Fault
			if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || completion != failure || completion.Outcome != store.TransactionUnknown || !completion.CommitAttempted || errors.As(err, &refusal) || !reflect.DeepEqual(result, botcore.BotPage{}) {
				t.Fatalf("failed completion exposed Bot data: %+v, %v", result, err)
			}
		})
	}
}
