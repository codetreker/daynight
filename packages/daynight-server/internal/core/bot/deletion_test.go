package bot

import (
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDeletionRequestPreservesOriginalIdentityAndObligations(t *testing.T) {
	input := store.DeleteBot{Version: 1, DeletionID: botID}
	bot := model.Bot{OwnerUserID: "owner", Version: 1, SessionID: ptr(workerID)}
	if err := RequireDeletionOwner(bot, model.Principal{UserID: "other"}); err == nil {
		t.Fatal("foreign owner was admitted")
	}
	if replay, err := DeletionRequest(bot, input); err != nil || replay {
		t.Fatalf("bound Bot must proceed through the Session barrier: %v %v", replay, err)
	}
	bot.Deletion = NewDeletion(input)
	bot.Deletion.WorkerCleanup.State = "completed"
	bot.Version++
	if replay, err := DeletionRequest(bot, input); err != nil || !replay || bot.Deletion.WorkerCleanup.State != "completed" {
		t.Fatalf("replay changed cleanup responsibility: %+v %v", bot, err)
	}
	changed := input
	changed.DeletionID = workerID
	_, err := DeletionRequest(bot, changed)
	assertFault(t, err, "resource_conflict")
	changed = input
	changed.Version++
	_, err = DeletionRequest(bot, changed)
	assertFault(t, err, "resource_conflict")
	bot.Deletion = nil
	_, err = DeletionRequest(bot, input)
	assertFault(t, err, "version_conflict")
	bot.Version = math.MaxInt64
	assertFault(t, CheckDeletionVersion(bot), "version_exhausted")
	deletion := NewDeletion(input)
	if deletion.DeletionID != input.DeletionID || deletion.RequestedVersion != input.Version || deletion.WorkerCleanup.State != "pending" || deletion.ServerCleanup.State != "pending" {
		t.Fatalf("unexpected initial deletion: %+v", deletion)
	}
}

func TestDeletionOwnerAllowsOwner(t *testing.T) {
	if err := RequireDeletionOwner(model.Bot{OwnerUserID: "owner"}, model.Principal{UserID: "owner"}); err != nil {
		t.Fatalf("owner was refused: %v", err)
	}
}

func TestDeletionVersionAllowsLastAdvance(t *testing.T) {
	for _, version := range []int64{1, math.MaxInt64 - 1} {
		if err := CheckDeletionVersion(model.Bot{Version: version}); err != nil {
			t.Fatalf("version %d cannot advance: %v", version, err)
		}
	}
}
