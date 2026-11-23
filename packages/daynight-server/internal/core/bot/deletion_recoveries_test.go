package bot

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type recoveryListCoreScope struct {
	store.SnapshotScope
	store.BotReader
	credential func(context.Context, model.Principal) (store.ThreadCredential, error)
	list       func(context.Context, string, store.Page) (store.BotPage, error)
}

func (s *recoveryListCoreScope) BotDAO() store.BotReader               { return s }
func (s *recoveryListCoreScope) CredentialDAO() store.CredentialReader { return s }
func (s *recoveryListCoreScope) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	return s.credential(ctx, p)
}
func (s *recoveryListCoreScope) BotDeletionRecoveries(ctx context.Context, owner string, page store.Page) (store.BotPage, error) {
	return s.list(ctx, owner, page)
}

func TestDeletionRecoveryListCursorIsolation(t *testing.T) {
	p := model.Principal{UserID: "a0000000-0000-4000-8000-000000000001"}
	bot := model.Bot{ID: "b0000000-0000-4000-8000-000000000001", CreatedAt: time.Date(2026, 11, 23, 1, 2, 3, 4, time.UTC)}
	cursor, err := DeletionRecoveryListCursor(p, store.BotPage{Items: []model.Bot{bot}, HasMore: true})
	if err != nil || cursor == nil {
		t.Fatalf("cursor: %v %v", cursor, err)
	}
	page, err := DeletionRecoveryListPage(p, model.PageRequest{Limit: 1, Cursor: cursor})
	if err != nil || page.After == nil || page.After.ID != bot.ID || !page.After.CreatedAt.Equal(bot.CreatedAt) {
		t.Fatalf("page: %+v %v", page, err)
	}
	other := p
	other.UserID = "a0000000-0000-4000-8000-000000000002"
	if _, err := DeletionRecoveryListPage(other, model.PageRequest{Limit: 1, Cursor: cursor}); err == nil {
		t.Fatal("cross-owner cursor accepted")
	}
	ordinary, err := query.EncodeListCursor(query.ListScope{Kind: "bots", WorkerUserID: &p.UserID}, bot.CreatedAt, bot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DeletionRecoveryListPage(p, model.PageRequest{Limit: 1, Cursor: &ordinary}); err == nil {
		t.Fatal("ordinary list cursor accepted")
	}
	for _, limit := range []int{0, 101} {
		if _, err := DeletionRecoveryListPage(p, model.PageRequest{Limit: limit}); err == nil {
			t.Fatalf("limit %d accepted", limit)
		}
	}
	if cursor, err := DeletionRecoveryListCursor(p, store.BotPage{}); err != nil || cursor != nil {
		t.Fatalf("terminal cursor: %v %v", cursor, err)
	}
	if _, err := DeletionRecoveryListCursor(p, store.BotPage{HasMore: true}); err == nil {
		t.Fatal("empty cursor boundary accepted")
	}
}

func TestDeletionRecoveryListAdmission(t *testing.T) {
	p := model.Principal{UserID: "owner"}
	ctx := t.Context()
	page := store.Page{Limit: 2}
	want := store.BotPage{Items: []model.Bot{{ID: "bot"}}}
	failure := errors.New("read failed")
	for _, blocked := range []string{"none", "credential", "admission", "missing-admission", "list"} {
		t.Run(blocked, func(t *testing.T) {
			calls := []string{}
			s := &recoveryListCoreScope{}
			s.credential = func(got context.Context, principal model.Principal) (store.ThreadCredential, error) {
				if got != ctx || principal != p {
					t.Fatal("credential identity changed")
				}
				calls = append(calls, "credential")
				if blocked == "credential" {
					return store.ThreadCredential{}, failure
				}
				return store.ThreadCredential{}, nil
			}
			s.list = func(got context.Context, owner string, input store.Page) (store.BotPage, error) {
				if got != ctx || owner != p.UserID || input.Limit != page.Limit {
					t.Fatal("list identity changed")
				}
				calls = append(calls, "list")
				if blocked == "list" {
					return store.BotPage{}, failure
				}
				return want, nil
			}
			admit := func() error {
				calls = append(calls, "admit")
				if blocked == "admission" {
					return failure
				}
				return nil
			}
			if blocked == "missing-admission" {
				admit = nil
			}
			got, err := ListDeletionRecoveries(ctx, s, p, page, admit)
			if blocked == "none" {
				if err != nil || len(got.Items) != 1 || got.Items[0].ID != "bot" || len(calls) != 3 {
					t.Fatalf("list: %+v %v calls %v", got, err, calls)
				}
			} else if err == nil || len(got.Items) != 0 {
				t.Fatalf("failure was hidden: %+v %v", got, err)
			}
			if blocked == "credential" && len(calls) != 1 || blocked == "admission" && len(calls) != 2 || blocked == "missing-admission" && len(calls) != 1 {
				t.Fatalf("work after refusal: %v", calls)
			}
		})
	}
}
