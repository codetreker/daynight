package session_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestSessionStoreFixtureClearsBotHistoryWindowState(t *testing.T) {
	suite := newSessionStoreSuite(t)
	id, resource := uuid.NewString(), uuid.NewString()
	suite.run(t, "persist history state", func(t *testing.T, db *postgres.Store) {
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			dao := base.(store.BotHistoryWindowDAO)
			if err := dao.SaveBotHistoryCheckpoint(t.Context(), id, []byte(`{"windowRevision":"1"}`)); err != nil {
				return err
			}
			return dao.QueueBotHistoryReclaim(t.Context(), id, resource)
		})
	})
	suite.run(t, "observe cleared history state", func(t *testing.T, db *postgres.Store) {
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			dao := base.(store.BotHistoryWindowDAO)
			if _, err := dao.BotHistoryCheckpoint(t.Context(), id); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("fixture retained checkpoint: %v", err)
			}
			pending, err := dao.PendingBotHistoryReclaims(t.Context(), id)
			if err != nil {
				return err
			}
			if len(pending) != 0 {
				t.Fatalf("fixture retained resource reclamation: %v", pending)
			}
			return nil
		})
	})
}

func TestBotHistoryWindowCheckpointAndReferenceTransaction(t *testing.T) {
	db := isolatedStore(t)
	id, _ := prepareImageSession(t, db)
	resource := uuid.NewString()
	ctx := t.Context()
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.BotHistoryWindowDAO)
		if _, err := dao.BotHistoryCheckpoint(ctx, id); !errors.Is(err, model.ErrNotFound) {
			t.Fatal(err)
		}
		if err := base.(store.SessionResourceDAO).InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Status: "available", Name: "original"}}); err != nil {
			return err
		}
		return dao.SaveBotHistoryCheckpoint(ctx, id, []byte(`{"windowRevision":"1"}`))
	})
	cause := errors.New("rollback checkpoint with its reference")
	_, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		base := scope.SessionDAO()
		if _, err := base.LockSession(ctx, id); err != nil {
			return err
		}
		dao := base.(store.BotHistoryWindowDAO)
		if err := dao.SaveBotHistoryCheckpoint(ctx, id, []byte(`{"windowRevision":"2"}`)); err != nil {
			return err
		}
		if err := base.(store.SessionResourceDAO).AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "bot_window", ReferenceID: "entry"}); err != nil {
			return err
		}
		if err := dao.QueueBotHistoryReclaim(ctx, id, resource); err != nil {
			return err
		}
		return cause
	})
	if !errors.Is(err, cause) {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.BotHistoryWindowDAO)
		raw, err := dao.BotHistoryCheckpoint(ctx, id)
		if err != nil {
			return err
		}
		if string(raw) != `{"windowRevision": "1"}` {
			t.Fatal("rollback changed checkpoint", string(raw))
		}
		refs, err := dao.SessionResourceReferences(ctx, id, "bot_window")
		if err != nil {
			return err
		}
		if len(refs) != 0 {
			t.Fatal("rollback published references", refs)
		}
		pending, err := dao.PendingBotHistoryReclaims(ctx, id)
		if err != nil {
			return err
		}
		if len(pending) != 0 {
			t.Fatal("rollback published queue", pending)
		}
		if err = dao.QueueBotHistoryReclaim(ctx, id, resource); err != nil {
			return err
		}
		return dao.QueueBotHistoryReclaim(ctx, id, resource)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.BotHistoryWindowDAO)
		pending, err := dao.PendingBotHistoryReclaims(ctx, id)
		if err != nil {
			return err
		}
		if len(pending) != 1 || pending[0] != resource {
			t.Fatal(pending)
		}
		ids, err := base.(store.BotHistoryReclaimInventoryDAO).BotHistoryReclaimSessions(ctx, "", 100)
		if err != nil {
			return err
		}
		found := false
		for _, v := range ids {
			found = found || v == id
		}
		if !found {
			t.Fatal(ids)
		}
		if _, err = base.(store.BotHistoryReclaimInventoryDAO).BotHistoryReclaimSessions(ctx, "", 0); err == nil {
			t.Fatal("unbounded inventory accepted")
		}
		if err = dao.CompleteBotHistoryReclaim(ctx, id, resource); err != nil {
			return err
		}
		return dao.CompleteBotHistoryReclaim(ctx, id, resource)
	})
}

func TestBotHistoryWindowReferencesKeepSharedResourcesAndReadLeases(t *testing.T) {
	db := isolatedStore(t)
	id, actor := prepareImageSession(t, db)
	resource := uuid.NewString()
	ctx := t.Context()
	window := store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "bot_window", ReferenceID: "entry"}
	operation := window
	operation.Kind = "operation"
	lease := uuid.NewString()
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		if err := d.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: resource, Status: "available", Name: "original"}}); err != nil {
			return err
		}
		for _, ref := range []store.SessionResourceReference{window, operation} {
			if err := d.AddSessionResourceReference(ctx, ref); err != nil {
				return err
			}
		}
		refs, err := base.(store.BotHistoryWindowDAO).SessionResourceReferences(ctx, id, "bot_window")
		if err != nil {
			return err
		}
		if len(refs) != 1 || refs[0] != window {
			t.Fatalf("window ownership query mixed independent owners or lost identity: %v", refs)
		}
		visible, err := d.SessionResourceReadableBy(ctx, id, resource, actor.UserID)
		if err != nil {
			return err
		}
		if !visible {
			t.Fatal("window resource hidden")
		}
		if err = d.RemoveSessionResourceReference(ctx, window); err != nil {
			return err
		}
		claimed, err := base.(store.SessionResourceSettlementDAO).MarkSessionResourceReclaim(ctx, id, resource)
		if err != nil {
			return err
		}
		if claimed {
			t.Fatal("operation owner ignored")
		}
		if err = d.RemoveSessionResourceReference(ctx, operation); err != nil {
			return err
		}
		if _, err = d.SessionResourceUsage(ctx, id); err != nil {
			return err
		}
		return d.AcquireSessionResourceLease(ctx, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: actor.UserID, ResourceID: resource, Kind: "read", Admission: store.SessionResourceLeaseAdmission{Global: 100, Owner: 10, Session: 4}})
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		d := base.(store.SessionResourceDAO)
		settle := base.(store.SessionResourceSettlementDAO)
		claimed, err := settle.MarkSessionResourceReclaim(ctx, id, resource)
		if err != nil {
			return err
		}
		if !claimed {
			t.Fatal("unowned resource not marked")
		}
		if err = d.AddSessionResourceReference(ctx, window); err == nil {
			t.Fatal("reclaiming resource resurrected")
		}
		if err = settle.DeleteReclaimedSessionResource(ctx, id, resource); err == nil {
			t.Fatal("read lease ignored")
		}
		if err = d.ReleaseSessionResourceLease(ctx, id, lease); err != nil {
			return err
		}
		return settle.DeleteReclaimedSessionResource(ctx, id, resource)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		_, err := base.(store.SessionResourceDAO).SavedSessionResource(context.Background(), id, resource)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatal(err)
		}
		return nil
	})
}

func TestBotHistoryWindowReferenceQueryPreservesDatabaseFailure(t *testing.T) {
	db := isolatedStore(t)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	refs, err := pgsession.New(tx).(store.BotHistoryWindowDAO).SessionResourceReferences(ctx, uuid.NewString(), "bot_window")
	if !errors.Is(err, context.Canceled) || refs != nil {
		t.Fatal("cancelled database read appeared to confirm an empty resource closure", refs, err)
	}
}
