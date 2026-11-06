package bot

import (
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
	change, err := PrepareDeletion(bot, request)
	if !change || err != nil {
		t.Fatalf("new request: %v %v", change, err)
	}
	bot.Deletion = NewDeletion(request)
	if change, err = PrepareDeletion(bot, request); change || err != nil {
		t.Fatalf("replay: %v %v", change, err)
	}
	if _, err = PrepareDeletion(bot, store.DeleteBot{Version: 5, DeletionID: "delete"}); faultCode(err) != "resource_conflict" {
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
