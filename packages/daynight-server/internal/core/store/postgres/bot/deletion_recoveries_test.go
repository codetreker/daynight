package bot_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBotDeletionRecoveriesOwnerFilterAndPagination(t *testing.T) {
	f := newFixture(t)
	reader := f.reader.(store.BotDeletionRecoveryLister)
	at := time.Date(2026, 11, 23, 1, 2, 3, 0, time.UTC)
	missing, other := "execution_evidence_missing", "private_cleanup_failed"
	decision := &model.BotDeletionRecovery{WorkerID: f.candidate.WorkerID, Decision: model.BotDeletionDecision{OperationID: uuid.NewString(), RequestedVersion: 1, ActorUserID: f.candidate.OwnerUserID, Reason: "Original storage is unavailable.", AcknowledgedAt: at, LocalDisposition: "unverified"}}
	types := []struct {
		worker   string
		code     *string
		server   string
		decision *model.BotDeletionRecovery
	}{
		{"pending", nil, "pending", nil}, {"failed", &other, "pending", nil}, {"failed", &missing, "pending", nil},
		{"failed", &missing, "completed", nil}, {"failed", &missing, "pending", decision}, {"failed", &missing, "completed", decision},
	}
	expected := []string{}
	for i, state := range types {
		candidate := f.candidate
		candidate.ID = uuid.NewString()
		bot := f.insert(t, candidate)
		d := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: bot.Version,
			WorkerCleanup: model.BotCleanupResult{State: state.worker, Code: state.code}, ServerCleanup: model.BotCleanupResult{State: state.server}, Recovery: state.decision}
		if _, err := f.writer.SaveBotDeletion(t.Context(), bot.ID, d); err != nil {
			t.Fatal(err)
		}
		exec(t, f.tx, `UPDATE bots SET created_at=$2 WHERE id=$1`, bot.ID, at.Add(time.Duration(i)*time.Second))
		if i == 2 || i == 4 || i == 5 {
			expected = append(expected, bot.ID)
		}
	}
	active := f.candidate
	active.ID = uuid.NewString()
	f.insert(t, active)
	otherOwner, otherWorker := uuid.NewString(), uuid.NewString()
	exec(t, f.tx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, otherOwner, "github:"+otherOwner)
	exec(t, f.tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{"state":"unavailable","items":[]}')`, otherOwner, otherWorker)
	foreign := f.candidate
	foreign.ID = uuid.NewString()
	foreign.OwnerUserID = otherOwner
	foreign.WorkerID = otherWorker
	foreign = f.insert(t, foreign)
	if _, err := f.writer.SaveBotDeletion(t.Context(), foreign.ID, &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: foreign.Version,
		WorkerCleanup: model.BotCleanupResult{State: "failed", Code: &missing}, ServerCleanup: model.BotCleanupResult{State: "pending"}}); err != nil {
		t.Fatal(err)
	}
	page := store.Page{Limit: 1}
	for i, id := range expected {
		got, err := reader.BotDeletionRecoveries(t.Context(), f.candidate.OwnerUserID, page)
		if err != nil || len(got.Items) != 1 || got.Items[0].ID != id || got.HasMore != (i < len(expected)-1) {
			t.Fatalf("page %d: %+v %v", i, got, err)
		}
		bot := got.Items[0]
		if bot.Name != "" || bot.ResolvedConfiguration.Cwd != "" || bot.RoleConfiguration != nil || bot.RequestFingerprint != "" {
			t.Fatal("list read private definition")
		}
		page.After = &store.Position{CreatedAt: bot.CreatedAt, ID: bot.ID}
	}
	empty, err := reader.BotDeletionRecoveries(t.Context(), f.candidate.OwnerUserID, page)
	if err != nil || len(empty.Items) != 0 || empty.HasMore {
		t.Fatalf("tail: %+v %v", empty, err)
	}
	foreignPage, err := reader.BotDeletionRecoveries(t.Context(), otherOwner, store.Page{Limit: 100})
	if err != nil || len(foreignPage.Items) != 1 || foreignPage.Items[0].ID != foreign.ID {
		t.Fatalf("foreign owner: %+v %v", foreignPage, err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := reader.BotDeletionRecoveries(canceled, f.candidate.OwnerUserID, store.Page{Limit: 1}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}
