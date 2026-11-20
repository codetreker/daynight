package assistanttask

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type scopedTaskDAO struct {
	store.AssistantTaskDAO
	authorization model.CredentialAuthorization
	reads         int
}

func (d *scopedTaskDAO) Credential(_ context.Context, _ model.Principal) error { return nil }
func (d *scopedTaskDAO) CredentialAuthorization(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	if p != d.authorization.Principal {
		panic("wrong credential in transaction")
	}
	d.reads++
	return d.authorization, nil
}
func (d *scopedTaskDAO) Task(_ context.Context, owner, id string, _ bool) (model.AssistantTask, error) {
	return model.AssistantTask{ID: id, OwnerUserID: owner, State: "active"}, nil
}
func (d *scopedTaskDAO) Now(context.Context) (time.Time, error) { return time.Unix(1, 0), nil }

func TestScopedGetUsesTransactionAuthorization(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy := func(id scopepolicy.ScopeID) *scopepolicy.Policy {
		p, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{id}, 1)
		if err != nil {
			t.Fatal(err)
		}
		return &p
	}
	observed := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: policy("assistant-task:read")}
	for _, tc := range []struct {
		name    string
		current scopepolicy.ScopeID
		allowed bool
		reads   int
	}{{"current read", "assistant-task:read", true, 2}, {"revoked read", "assistant-task:operate", false, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			dao := &scopedTaskDAO{authorization: model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: policy(tc.current)}}
			transactions := 0
			s := New(transactionMock{run: func(_ context.Context, callback func(store.AssistantTaskScope) error) (store.Completion, error) {
				transactions++
				err := callback(scopeMock{dao})
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}})
			result, err := s.Get(context.Background(), core.Actor{Principal: principal, Authorization: &observed}, "33333333-3333-4333-8333-333333333333")
			if transactions != 1 || dao.reads != tc.reads {
				t.Fatalf("transactions=%d authorization reads=%d", transactions, dao.reads)
			}
			if tc.allowed {
				if err != nil || result.Task.ID == "" {
					t.Fatalf("result=%+v error=%v", result, err)
				}
			} else if !errors.Is(err, scopepolicy.ErrInsufficientScope) || result.Task.ID != "" {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}
