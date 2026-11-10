package bot

import (
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestCleanupFailurePreservesWorkerReceiptAndDefinition(t *testing.T) {
	now := time.Date(2026, 11, 8, 2, 0, 0, 123456000, time.UTC)
	bot := model.Bot{ID: botID, OwnerUserID: "owner", WorkerID: workerID, Name: "助手", Version: 9007199254740993, CreationOrder: 41, CreatedAt: now, UpdatedAt: now.Add(time.Hour), SessionID: ptr("bound-session"), Deletion: &model.BotDeletion{DeletionID: "delete", RequestedVersion: 9007199254740992, ReceiptDigest: "original-worker-receipt", WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}}
	want := bot
	deletion := *bot.Deletion
	want.Deletion = &deletion
	code := "server_cleanup_failed"
	deletion.ServerCleanup = model.BotCleanupResult{State: "failed", Code: &code}
	changed, err := FailServerCleanup(&bot, "delete")
	if err != nil || !changed || !reflect.DeepEqual(bot, want) {
		t.Fatalf("cleanup failure changed independent facts: %+v %v changed=%t", bot, err, changed)
	}
	bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
	deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
	changed, err = FailServerCleanup(&bot, "delete")
	if err != nil || changed || !reflect.DeepEqual(bot, want) {
		t.Fatalf("failure downgraded concurrent completion: %+v %v changed=%t", bot, err, changed)
	}
}
