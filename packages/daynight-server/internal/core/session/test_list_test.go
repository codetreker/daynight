package session

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func listCredential(t *testing.T, f fixture, user string, kind model.CredentialKind) model.Principal {
	t.Helper()
	p := model.Principal{Kind: kind, UserID: user, CredentialID: uuid.NewString()}
	priorLock := f.dao.LockCredentialFn
	f.dao.LockCredentialFn = func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual == p {
			return nil
		}
		return priorLock(ctx, actual, now)
	}
	priorRead := f.dao.ReadCredentialFn
	f.dao.ReadCredentialFn = func(ctx context.Context, actual model.Principal, now time.Time) error {
		if actual == p {
			return nil
		}
		if priorRead == nil {
			panic("unexpected ReadCredential")
		}
		return priorRead(ctx, actual, now)
	}
	return p
}

type standaloneListDAO struct {
	store.SessionDAO
	list func(context.Context, string, time.Time, int, bool, time.Time, *time.Time, string) ([]store.TestSessionListItem, error)
}

func (d *standaloneListDAO) ListTestSessions(ctx context.Context, owner string, now time.Time, limit int, online bool, heartbeat time.Time, cursor *time.Time, id string) ([]store.TestSessionListItem, error) {
	if d.list == nil {
		panic("unexpected ListTestSessions")
	}
	return d.list(ctx, owner, now, limit, online, heartbeat, cursor, id)
}

type standaloneListScope struct {
	store.SessionScope
	dao store.SessionDAO
}

func (s standaloneListScope) SessionDAO() store.SessionDAO { return s.dao }
func (s standaloneListScope) BotDAO() store.BotWriteDAO    { return nil }

type standaloneListCall struct {
	actor                       model.Principal
	limit                       int
	online                      bool
	cursor                      *time.Time
	id                          string
	items                       []store.TestSessionListItem
	credentialError, queryError error
}

func standaloneListExecution(t *testing.T, now time.Time, calls ...standaloneListCall) *Execution {
	t.Helper()
	s := &Execution{Engine: NewEngine(nil)}
	s.now = func() time.Time { return now }
	index := 0
	s.credentialRun = func(ctx context.Context, actor model.Principal, work func(*Operation, store.SessionScope) error) error {
		if index >= len(calls) {
			t.Fatal("unexpected credential runner call")
		}
		want := calls[index]
		index++
		if actor != want.actor {
			t.Fatalf("credential actor %+v want %+v", actor, want.actor)
		}
		if want.credentialError != nil {
			return want.credentialError
		}
		daoCalls := 0
		dao := &standaloneListDAO{list: func(actual context.Context, owner string, at time.Time, limit int, online bool, heartbeat time.Time, cursor *time.Time, id string) ([]store.TestSessionListItem, error) {
			daoCalls++
			if daoCalls != 1 || actual != ctx || owner != actor.UserID || !at.Equal(now) || limit != want.limit || online != want.online || !heartbeat.Equal(now.Add(-HeartbeatTimeout)) || !reflect.DeepEqual(cursor, want.cursor) || id != want.id {
				t.Fatalf("ListTestSessions call: owner=%s now=%s limit=%d online=%t heartbeat=%s cursor=%v id=%s", owner, at, limit, online, heartbeat, cursor, id)
			}
			return want.items, want.queryError
		}}
		op, err := s.BeginOperation()
		if err != nil {
			return err
		}
		defer op.Close()
		err = work(op, standaloneListScope{dao: dao})
		if daoCalls != 1 {
			t.Fatalf("ListTestSessions calls %d want 1", daoCalls)
		}
		if err == nil {
			op.Finish(store.TransactionCommitted)
		} else {
			op.Finish(store.TransactionNotCommitted)
		}
		return err
	}
	t.Cleanup(func() {
		if index != len(calls) {
			t.Errorf("credential runner calls %d want %d", index, len(calls))
		}
	})
	return s
}
func standaloneListRow(id, provider, lifecycle, connection string, created, updated time.Time) store.TestSessionListItem {
	return store.TestSessionListItem{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, Identity: sp.Identity{Provider: provider}, Lifecycle: lifecycle, ConnectionState: connection}, CreatedAt: created, UpdatedAt: updated}
}
func TestListTestSessionsUsesOwnerParentAndStableActivityPagination(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	created, eventTime := now.Add(-time.Hour), now.Add(-59*time.Minute)
	actor := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	other := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	a := standaloneListRow(uuid.NewString(), "codex", "archived", "connected", created, eventTime)
	a.LastSeen = &eventTime
	b := standaloneListRow(uuid.NewString(), "copilot", "active", "disconnected", created.Add(2*time.Second), created.Add(2*time.Second))
	c := standaloneListRow(uuid.NewString(), "claude", "active", "disconnected", created.Add(time.Second), created.Add(time.Second))
	foreign := standaloneListRow(uuid.NewString(), "codex", "active", "disconnected", created, created)
	refusal := &model.Fault{Code: "unauthenticated", Message: "Credential is revoked."}
	s := standaloneListExecution(t, now, standaloneListCall{actor: actor, limit: 2, items: []store.TestSessionListItem{a, b, c}}, standaloneListCall{actor: actor, limit: 2, cursor: &b.UpdatedAt, id: b.Snapshot.SessionID, items: []store.TestSessionListItem{c}}, standaloneListCall{actor: other, limit: 50, items: []store.TestSessionListItem{foreign}}, standaloneListCall{actor: actor, limit: 50, items: []store.TestSessionListItem{}}, standaloneListCall{actor: actor, credentialError: refusal})
	page, err := s.ListTest(ctx, actor, "", 2, false)
	if err != nil || len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatal("first page", page, err)
	}
	if page.Items[0].SessionID != a.Snapshot.SessionID || page.Items[0].Lifecycle != "archived" || page.Items[0].ConnectionState != "disconnected" || !page.Items[0].CreatedAt.Equal(created) || !page.Items[0].UpdatedAt.Equal(eventTime) || page.Items[1].SessionID != b.Snapshot.SessionID {
		t.Fatal("order/metadata", page)
	}
	tail, err := s.ListTest(ctx, actor, *page.NextCursor, 2, false)
	if err != nil || len(tail.Items) != 1 || tail.Items[0].SessionID != c.Snapshot.SessionID || tail.NextCursor != nil {
		t.Fatal("tail", tail, err)
	}
	if _, err := s.ListTest(ctx, other, *page.NextCursor, 2, false); err == nil {
		t.Fatal("cross-owner cursor accepted")
	}
	otherPage, err := s.ListTest(ctx, other, "", 50, false)
	if err != nil || len(otherPage.Items) != 1 || otherPage.Items[0].SessionID != foreign.Snapshot.SessionID {
		t.Fatal("foreign owner", otherPage, err)
	}
	revoked, err := s.ListTest(ctx, actor, "", 50, false)
	if err != nil || revoked.Items == nil || len(revoked.Items) != 0 {
		t.Fatal("empty DAO result", revoked, err)
	}
	if _, err := s.ListTest(ctx, actor, "", 50, false); err != refusal {
		t.Fatal("credential refusal lost", err)
	}
}
func TestListTestSessionsTieCursorAndReadState(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	created := now.Add(-time.Hour)
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	high, low := "ffffffff-ffff-4fff-8fff-ffffffffffff", "00000000-0000-4000-8000-000000000000"
	a := standaloneListRow(high, "codex", "active", "connected", created, created)
	b := standaloneListRow(low, "claude", "active", "connected", created, created)
	lastSeen := now.Add(-time.Minute)
	a.LastSeen, b.LastSeen = &lastSeen, &lastSeen
	drain := now.Add(-time.Second)
	archived := a
	archived.Snapshot.Lifecycle = "draining"
	archived.DrainUntil = &drain
	cause := errors.New("invalid stored Session snapshot")
	queryError := fmt.Errorf("list Session: %w", cause)
	s := standaloneListExecution(t, now, standaloneListCall{actor: actor, limit: 1, items: []store.TestSessionListItem{a, b}}, standaloneListCall{actor: actor, limit: 1, cursor: &created, id: high, items: []store.TestSessionListItem{b}}, standaloneListCall{actor: actor, limit: 50, items: []store.TestSessionListItem{archived, b}}, standaloneListCall{actor: actor, limit: 50, queryError: queryError})
	page, err := s.ListTest(ctx, actor, "", 1, false)
	if err != nil || len(page.Items) != 1 || page.Items[0].SessionID != high || page.Items[0].ConnectionState != "disconnected" || page.NextCursor == nil {
		t.Fatal(page, err)
	}
	tail, err := s.ListTest(ctx, actor, *page.NextCursor, 1, false)
	if err != nil || len(tail.Items) != 1 || tail.Items[0].SessionID != low || tail.NextCursor != nil {
		t.Fatal(tail, err)
	}
	for _, limit := range []int{0, 101} {
		if _, err := s.ListTest(ctx, actor, "", limit, false); err == nil {
			t.Fatal("limit accepted", limit)
		}
	}
	position := testListPosition{Kind: "test-sessions", Owner: actor.UserID, UpdatedAt: created, SessionID: high}
	for _, raw := range []string{"bad", strings.Repeat("a", 513), base64.RawURLEncoding.EncodeToString([]byte(`{"kind":"test-sessions","extra":1}`)), base64.RawURLEncoding.EncodeToString(encode(testListPosition{Kind: position.Kind, Owner: position.Owner, UpdatedAt: created, SessionID: "bad"})), base64.RawURLEncoding.EncodeToString(encode(testListPosition{Kind: position.Kind, Owner: position.Owner, SessionID: high}))} {
		if _, err := s.ListTest(ctx, actor, raw, 1, false); err == nil {
			t.Fatal("cursor accepted", raw)
		}
	}
	all, err := s.ListTest(ctx, actor, "", 50, false)
	if err != nil || all.Items[0].Lifecycle != "archived" || all.Items[0].ConnectionState != "disconnected" {
		t.Fatal(all, err)
	}
	if _, err := s.ListTest(ctx, actor, "", 50, false); err != queryError || !errors.Is(err, cause) {
		t.Fatal("DAO error chain lost", err)
	}
}
func TestListOnlineTestSessionsFiltersBeforePaginationAndBindsCursor(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	a := standaloneListRow(uuid.NewString(), "claude", "active", "synchronizing", now.Add(-time.Hour+time.Second), now.Add(-time.Hour+time.Second))
	b := standaloneListRow(uuid.NewString(), "codex", "active", "connected", now.Add(-time.Hour), now.Add(-time.Hour))
	edge := now.Add(-HeartbeatTimeout)
	a.LastSeen, b.LastSeen = &now, &edge
	s := standaloneListExecution(t, now, standaloneListCall{actor: actor, limit: 1, online: true, items: []store.TestSessionListItem{a, b}}, standaloneListCall{actor: actor, limit: 1, online: true, cursor: &a.UpdatedAt, id: a.Snapshot.SessionID, items: []store.TestSessionListItem{b}}, standaloneListCall{actor: actor, limit: 1, items: []store.TestSessionListItem{a, b}}, standaloneListCall{actor: actor, limit: 50, online: true, items: []store.TestSessionListItem{}}, standaloneListCall{actor: actor, limit: 50, items: []store.TestSessionListItem{a, b}})
	page, err := s.ListTest(ctx, actor, "", 1, true)
	if err != nil || len(page.Items) != 1 || page.Items[0].SessionID != a.Snapshot.SessionID || page.Items[0].ConnectionState != "connected" || page.NextCursor == nil {
		t.Fatal("online first page", page, err)
	}
	tail, err := s.ListTest(ctx, actor, *page.NextCursor, 1, true)
	if err != nil || len(tail.Items) != 1 || tail.Items[0].SessionID != b.Snapshot.SessionID || tail.Items[0].ConnectionState != "connected" || tail.NextCursor != nil {
		t.Fatal("online tail", tail, err)
	}
	if _, err := s.ListTest(ctx, actor, *page.NextCursor, 1, false); err == nil {
		t.Fatal("online cursor accepted for all")
	}
	all, err := s.ListTest(ctx, actor, "", 1, false)
	if err != nil || all.NextCursor == nil {
		t.Fatal(all, err)
	}
	if _, err := s.ListTest(ctx, actor, *all.NextCursor, 1, true); err == nil {
		t.Fatal("all cursor accepted for online")
	}
	empty, err := s.ListTest(ctx, actor, "", 50, true)
	if err != nil || empty.Items == nil || len(empty.Items) != 0 {
		t.Fatal("empty online page", empty, err)
	}
	history, err := s.ListTest(ctx, actor, "", 50, false)
	if err != nil || len(history.Items) != 2 {
		t.Fatal("readable history", history, err)
	}
}
