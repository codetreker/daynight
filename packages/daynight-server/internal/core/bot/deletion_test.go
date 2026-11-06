package bot

import (
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestCleanupResultValidity(t *testing.T) {
	good, blank, nul, invalid := "disk_error", " \t", "x\x00y", string([]byte{0xff})
	for _, tc := range []struct {
		name   string
		result model.BotCleanupResult
		want   bool
	}{
		{"completed", model.BotCleanupResult{State: "completed"}, true},
		{"completed with code", model.BotCleanupResult{State: "completed", Code: &good}, false},
		{"failed", model.BotCleanupResult{State: "failed", Code: &good}, true},
		{"failed without code", model.BotCleanupResult{State: "failed"}, false},
		{"blank code", model.BotCleanupResult{State: "failed", Code: &blank}, false},
		{"NUL code", model.BotCleanupResult{State: "failed", Code: &nul}, false},
		{"invalid UTF-8", model.BotCleanupResult{State: "failed", Code: &invalid}, false},
		{"pending", model.BotCleanupResult{State: "pending"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidCleanupResult(tc.result); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func faultCode(err error) string {
	if fault, ok := err.(*model.Fault); ok {
		return fault.Code
	}
	return ""
}

func TestDeletionStateTransitions(t *testing.T) {
	request := store.DeleteBot{Version: 4, DeletionID: "delete"}
	bot := model.Bot{Version: 4, WorkerID: "worker"}
	replay, err := DeletionRequest(bot, request)
	if replay || err != nil {
		t.Fatalf("new request: %v %v", replay, err)
	}
	bot.Deletion = NewDeletion(request)
	if replay, err = DeletionRequest(bot, request); !replay || err != nil {
		t.Fatalf("replay: %v %v", replay, err)
	}
	if _, err = DeletionRequest(bot, store.DeleteBot{Version: 5, DeletionID: "delete"}); faultCode(err) != "resource_conflict" {
		t.Fatalf("request conflict: %v", err)
	}
	if _, _, err = PrepareWorkerCleanup(bot, "other", "delete", model.BotCleanupResult{}, "digest"); faultCode(err) != "forbidden" {
		t.Fatalf("worker: %v", err)
	}
	if _, _, err = PrepareWorkerCleanup(bot, "worker", "other", model.BotCleanupResult{}, "digest"); faultCode(err) != "session_conflict" {
		t.Fatalf("deletion identity: %v", err)
	}
	code := "failure"
	failed := model.BotCleanupResult{State: "failed", Code: &code}
	change, proof, err := PrepareWorkerCleanup(bot, "worker", "delete", failed, "ignored")
	if !change || proof || err != nil {
		t.Fatalf("failure: %v %v %v", change, proof, err)
	}
	ApplyWorkerCleanup(&bot, failed, "ignored")
	if change, _, err = PrepareWorkerCleanup(bot, "worker", "delete", failed, "different"); change || err != nil {
		t.Fatalf("failure replay: %v %v", change, err)
	}
	completed := model.BotCleanupResult{State: "completed"}
	change, proof, err = PrepareWorkerCleanup(bot, "worker", "delete", completed, "digest")
	if !change || !proof || err != nil {
		t.Fatalf("completed: %v %v %v", change, proof, err)
	}
	ApplyWorkerCleanup(&bot, completed, "digest")
	if change, _, err = PrepareWorkerCleanup(bot, "worker", "delete", completed, "digest"); change || err != nil {
		t.Fatalf("completed replay: %v %v", change, err)
	}
	if _, _, err = PrepareWorkerCleanup(bot, "worker", "delete", completed, "different"); faultCode(err) != "session_conflict" {
		t.Fatalf("receipt conflict: %v", err)
	}
	if !NeedsServerCleanup(bot) {
		t.Fatal("server cleanup required")
	}
	if change, err = PrepareServerCleanup(bot, "delete"); !change || err != nil {
		t.Fatalf("prepare server: %v %v", change, err)
	}
	if change, err = FailServerCleanup(&bot, "delete"); !change || err != nil || bot.Deletion.ServerCleanup.State != "failed" {
		t.Fatalf("record failure: %v %v", change, err)
	}
	if change, err = PrepareServerCleanup(bot, "delete"); !change || err != nil {
		t.Fatalf("retry: %v %v", change, err)
	}
	CompleteServerCleanup(&bot)
	if change, err = FailServerCleanup(&bot, "delete"); change || err != nil || bot.Deletion.ServerCleanup.State != "completed" {
		t.Fatalf("downgrade: %v %v", change, err)
	}
	if change, err = PrepareServerCleanup(bot, "delete"); change || err != nil || NeedsServerCleanup(bot) {
		t.Fatalf("completed server replay: %v %v", change, err)
	}
	if _, err = FailServerCleanup(&bot, "other"); faultCode(err) != "session_conflict" {
		t.Fatalf("failure identity: %v", err)
	}
}

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
