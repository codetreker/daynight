package bot

import (
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

const resolutionID = "a0000000-0000-4000-8000-000000000099"

func resolutionFixture() (model.Bot, ResolveDeletion) {
	code := MissingExecutionEvidence
	return model.Bot{ID: botID, OwnerUserID: resolutionID, WorkerID: workerID, Version: 9,
			Deletion: &model.BotDeletion{DeletionID: resolutionID, RequestedVersion: 7, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: &code}, ServerCleanup: model.BotCleanupResult{State: "pending"}}},
		ResolveDeletion{Action: "accept_unverified", Version: 9, DeletionID: resolutionID, OperationID: botID, AcknowledgeLocalUnverified: true, Reason: "原执行证据丢失\n接受本地未核实"}
}

func resolutionBinding() *model.BotDeletionBinding {
	return &model.BotDeletionBinding{SessionID: botID, TestExecutionID: resolutionID, ExecutionGeneration: "2", ControllerID: workerID, ControllerInstanceID: resolutionID}
}

func TestDeletionRecoveryDecisionAndLateReceipts(t *testing.T) {
	bot, input := resolutionFixture()
	bot.Recovery = &model.BotRecovery{WorkerID: resolutionID}
	binding := resolutionBinding()
	if replay, err := CheckDeletionResolution(bot, input); replay || err != nil {
		t.Fatalf("accept: %v %v", replay, err)
	}
	if !DeletionRecoveryRequired(bot) {
		t.Fatal("missing evidence was hidden")
	}
	before, err := ProjectDeletionRecovery(bot, binding)
	if err != nil || !before.RequiresStopProof || !before.RecoveryRequired || before.Decision != nil || before.HostingWorkerID != resolutionID || before.WorkerID != workerID {
		t.Fatalf("before: %+v %v", before, err)
	}
	ApplyDeletionResolution(&bot, input, binding, time.Date(2026, 11, 23, 1, 2, 3, 0, time.FixedZone("test", 3600)))
	bot.Version++
	if !NeedsServerCleanup(bot) || bot.Deletion.WorkerCleanup.State != "failed" || bot.Deletion.ReceiptDigest != "" || DeletionRecoveryRequired(bot) {
		t.Fatal("owner decision became a Worker success")
	}
	if change, err := PrepareServerCleanup(bot, input.DeletionID); !change || err != nil {
		t.Fatalf("cleanup: %v %v", change, err)
	}
	if replay, err := CheckDeletionResolution(bot, input); !replay || err != nil {
		t.Fatalf("exact replay: %v %v", replay, err)
	}
	for _, result := range []model.BotCleanupResult{{State: "completed"}, bot.Deletion.WorkerCleanup} {
		if _, _, err := PrepareWorkerCleanup(bot, resolutionID, input.DeletionID, result, "late"); faultCode(err) != "resource_conflict" {
			t.Fatalf("late receipt: %v", err)
		}
	}
	if _, _, err := PrepareWorkerCleanup(bot, workerID, input.DeletionID, model.BotCleanupResult{}, ""); faultCode(err) != "forbidden" {
		t.Fatalf("host admission: %v", err)
	}
	if _, _, err := PrepareWorkerCleanup(bot, resolutionID, botID, model.BotCleanupResult{}, ""); faultCode(err) != "session_conflict" {
		t.Fatalf("deletion admission: %v", err)
	}
	CompleteServerCleanup(&bot)
	bot.SessionID, bot.TestExecutionID = nil, nil
	bot.Recovery = nil
	after, err := ProjectDeletionRecovery(bot, nil)
	if err != nil || !reflect.DeepEqual(after.OriginalBinding, binding) || !after.RequiresStopProof || after.HostingWorkerID != resolutionID || after.Decision.ActorUserID != bot.OwnerUserID || after.Decision.LocalDisposition != "unverified" || after.ServerCleanup.State != "completed" || after.WorkerCleanup.State != "failed" {
		t.Fatalf("after: %+v %v", after, err)
	}
	if NeedsServerCleanup(bot) {
		t.Fatal("completed cleanup still requested")
	}
	if replay, err := CheckDeletionResolution(bot, input); !replay || err != nil {
		t.Fatalf("completed decision replay: %v %v", replay, err)
	}
}

func TestDeletionRecoveryInputAndStateRefusals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*model.Bot, *ResolveDeletion)
		code   string
	}{
		{"active", func(b *model.Bot, _ *ResolveDeletion) { b.Deletion = nil }, "resource_conflict"},
		{"deletion changed", func(_ *model.Bot, i *ResolveDeletion) { i.DeletionID = workerID }, "resource_conflict"},
		{"version", func(_ *model.Bot, i *ResolveDeletion) { i.Version++ }, "version_conflict"},
		{"exhausted", func(b *model.Bot, i *ResolveDeletion) { b.Version = math.MaxInt64; i.Version = b.Version }, "version_exhausted"},
		{"normal proof won", func(b *model.Bot, _ *ResolveDeletion) {
			b.Deletion.WorkerCleanup = model.BotCleanupResult{State: "completed"}
		}, "resource_conflict"},
		{"server complete", func(b *model.Bot, _ *ResolveDeletion) { b.Deletion.ServerCleanup.State = "completed" }, "resource_conflict"},
		{"pending", func(b *model.Bot, _ *ResolveDeletion) { b.Deletion.WorkerCleanup.State = "pending" }, "resource_conflict"},
		{"other failure", func(b *model.Bot, _ *ResolveDeletion) {
			s := "private_cleanup_failed"
			b.Deletion.WorkerCleanup.Code = &s
		}, "resource_conflict"},
		{"missing failure", func(b *model.Bot, _ *ResolveDeletion) { b.Deletion.WorkerCleanup.Code = nil }, "resource_conflict"},
		{"retry without decision", func(_ *model.Bot, i *ResolveDeletion) {
			i.Action = "retry_cleanup"
			i.Reason = ""
			i.AcknowledgeLocalUnverified = false
		}, "resource_conflict"},
		{"operation ID", func(_ *model.Bot, i *ResolveDeletion) { i.OperationID = "bad" }, "invalid_input"},
		{"deletion ID", func(_ *model.Bot, i *ResolveDeletion) { i.DeletionID = "bad" }, "invalid_input"},
		{"zero version", func(_ *model.Bot, i *ResolveDeletion) { i.Version = 0 }, "invalid_input"},
		{"action", func(_ *model.Bot, i *ResolveDeletion) { i.Action = "force" }, "invalid_input"},
		{"acknowledgement", func(_ *model.Bot, i *ResolveDeletion) { i.AcknowledgeLocalUnverified = false }, "invalid_input"},
		{"blank reason", func(_ *model.Bot, i *ResolveDeletion) { i.Reason = " \t\n" }, "invalid_input"},
		{"NUL reason", func(_ *model.Bot, i *ResolveDeletion) { i.Reason = "bad\x00reason" }, "invalid_input"},
		{"invalid UTF8", func(_ *model.Bot, i *ResolveDeletion) { i.Reason = string([]byte{255}) }, "invalid_input"},
		{"long reason", func(_ *model.Bot, i *ResolveDeletion) { i.Reason = strings.Repeat("中", 1001) }, "invalid_input"},
		{"retry replacement", func(_ *model.Bot, i *ResolveDeletion) { i.Action = "retry_cleanup" }, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, i := resolutionFixture()
			tc.mutate(&b, &i)
			if _, err := CheckDeletionResolution(b, i); faultCode(err) != tc.code {
				t.Fatalf("error: %v", err)
			}
		})
	}
	_, i := resolutionFixture()
	i.Reason = strings.Repeat("中", 1000)
	if err := ValidateDeletionResolution(i); err != nil {
		t.Fatal(err)
	}
}

func TestDeletionRecoveryRetryAndImmutableDecision(t *testing.T) {
	bot, input := resolutionFixture()
	ApplyDeletionResolution(&bot, input, nil, time.Now())
	bot.Version++
	decision := *bot.Deletion.Recovery
	for _, change := range []func(*ResolveDeletion){func(i *ResolveDeletion) { i.OperationID = workerID }, func(i *ResolveDeletion) { i.Reason += "changed" }, func(i *ResolveDeletion) { i.Version++ }} {
		other := input
		change(&other)
		if _, err := CheckDeletionResolution(bot, other); faultCode(err) != "resource_conflict" {
			t.Fatalf("replacement: %v", err)
		}
	}
	retry := ResolveDeletion{Action: "retry_cleanup", Version: bot.Version, DeletionID: input.DeletionID, OperationID: input.OperationID}
	if replay, err := CheckDeletionResolution(bot, retry); replay || err != nil {
		t.Fatalf("retry: %v %v", replay, err)
	}
	ApplyDeletionResolution(&bot, retry, nil, time.Now())
	bot.Version++
	if !reflect.DeepEqual(*bot.Deletion.Recovery, decision) {
		t.Fatal("retry replaced the owner decision")
	}
	if _, err := CheckDeletionResolution(bot, retry); faultCode(err) != "version_conflict" {
		t.Fatalf("stale retry: %v", err)
	}
	retry.Version = bot.Version
	CompleteServerCleanup(&bot)
	if _, err := CheckDeletionResolution(bot, retry); faultCode(err) != "resource_conflict" {
		t.Fatalf("already clean: %v", err)
	}
	bot.Deletion.Recovery.Decision.LocalDisposition = "completed"
	if _, err := CheckDeletionResolution(bot, input); err == nil {
		t.Fatal("invalid stored decision accepted")
	}
	if _, err := ProjectDeletionRecovery(bot, nil); err == nil {
		t.Fatal("invalid stored decision projected")
	}
	if _, err := PrepareServerCleanup(bot, input.DeletionID); err == nil {
		t.Fatal("invalid stored decision authorized cleanup")
	}
}

func TestDeletionRecoveryBindingEvidence(t *testing.T) {
	bot, _ := resolutionFixture()
	if binding, err := DeletionBinding(bot, nil); binding != nil || err != nil {
		t.Fatalf("unbound: %v %v", binding, err)
	}
	execution := resolutionID
	session := botID
	bot.TestExecutionID = &execution
	if _, err := DeletionBinding(bot, nil); err == nil {
		t.Fatal("orphan execution accepted")
	}
	bot.SessionID = &session
	if _, err := DeletionBinding(bot, nil); err == nil {
		t.Fatal("missing snapshot accepted")
	}
	v := sp.Snapshot{}
	v.SessionID, v.TestExecutionID, v.ExecutionGeneration = session, execution, "2"
	v.Identity.OwnerUserID, v.Identity.ControllerID, v.Identity.ControllerInstanceID = bot.OwnerUserID, workerID, resolutionID
	if binding, err := DeletionBinding(bot, &v); err != nil || !reflect.DeepEqual(binding, resolutionBinding()) {
		t.Fatalf("binding: %+v %v", binding, err)
	}
	for _, change := range []func(*sp.Snapshot){func(v *sp.Snapshot) { v.SessionID = workerID }, func(v *sp.Snapshot) { v.Identity.OwnerUserID = workerID }, func(v *sp.Snapshot) { v.TestExecutionID = workerID }, func(v *sp.Snapshot) { v.ExecutionGeneration = "02" }, func(v *sp.Snapshot) { v.Identity.ControllerID = "bad" }} {
		other := v
		change(&other)
		if _, err := DeletionBinding(bot, &other); err == nil {
			t.Fatal("changed binding accepted")
		}
	}
	bot.Deletion = nil
	if _, err := ProjectDeletionRecovery(bot, nil); faultCode(err) != "resource_conflict" {
		t.Fatalf("active sidecar: %v", err)
	}
}
