package bot

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type frozenReplayDAO struct {
	store.BotWriteDAO
	t     *testing.T
	ctx   context.Context
	p     model.Principal
	bot   model.Bot
	calls []string
}

func (d *frozenReplayDAO) Credential(ctx context.Context, p model.Principal) error {
	d.t.Helper()
	if ctx != d.ctx || p != d.p {
		d.t.Fatal("replay changed authority/context")
	}
	d.calls = append(d.calls, "credential")
	return nil
}
func (d *frozenReplayDAO) LockCreation(ctx context.Context, id string) error {
	d.t.Helper()
	if ctx != d.ctx || id != d.bot.ID {
		d.t.Fatal("replay locked another identity")
	}
	d.calls = append(d.calls, "lock")
	return nil
}
func (d *frozenReplayDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.t.Helper()
	if ctx != d.ctx || id != d.bot.ID {
		d.t.Fatal("replay read another identity")
	}
	d.calls = append(d.calls, "bot")
	return d.bot, nil
}
func TestCreationReplayPreservesCompleteFrozenDefinition(t *testing.T) {
	in, fp, err := NormalizeBotRequest(input())
	if err != nil {
		t.Fatal(err)
	}
	p := model.Principal{Kind: model.SessionCredential, UserID: "owner", CredentialID: "session"}
	now := time.Date(2026, 11, 9, 0, 0, 0, 123456000, time.UTC)
	want := model.Bot{ID: in.ID, OwnerUserID: p.UserID, WorkerID: workerID, Name: in.Name, Version: 9007199254740993, CreationOrder: 31, RequestFingerprint: fp, RequestedOverrides: in.Overrides, ResolvedConfiguration: in.ResolvedConfiguration, RoleConfiguration: &model.BotRoleConfiguration{Instructions: "frozen", Revision: "2", Digest: "original"}, SessionID: ptr("bound-session"), TestExecutionID: ptr("execution"), StartupResult: model.BotStartupResult{State: "ready"}, CreatedAt: now, UpdatedAt: now.Add(time.Hour)}
	in.ResolvedConfiguration.Cwd = "/new/default"
	in.ResolutionError = &model.Fault{Code: "resource_conflict", Message: "discovery failed"}
	dao := &frozenReplayDAO{t: t, ctx: t.Context(), p: p, bot: want}
	got, err := Create(t.Context(), dao, p, in, fp, true)
	if err != nil || !reflect.DeepEqual(got, want) || !reflect.DeepEqual(dao.calls, []string{"credential", "lock", "bot", "credential"}) {
		t.Fatalf("frozen replay: %+v %v calls=%v", got, err, dao.calls)
	}
}
func TestChangedFailedCleanupReceiptPreservesServerResponsibility(t *testing.T) {
	oldCode, newCode := "process_not_stopped", "private_cleanup_failed"
	original := model.Bot{WorkerID: workerID, Version: 4, Deletion: &model.BotDeletion{DeletionID: "delete", RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: &oldCode}, ServerCleanup: model.BotCleanupResult{State: "pending"}}}
	input := model.BotCleanupResult{State: "failed", Code: &newCode}
	change, proof, err := PrepareWorkerCleanup(original, workerID, "delete", input, "new-digest")
	if err != nil || !change || proof {
		t.Fatalf("changed failure lost: %v %v %v", change, proof, err)
	}
	ApplyWorkerCleanup(&original, input, "new-digest")
	if original.Deletion.ServerCleanup.State != "pending" || original.Deletion.ReceiptDigest != "" || !reflect.DeepEqual(original.Deletion.WorkerCleanup, input) {
		t.Fatalf("failure lost responsibility: %+v", original.Deletion)
	}
	change, proof, err = PrepareWorkerCleanup(original, workerID, "delete", input, "different-digest")
	if err != nil || change || proof {
		t.Fatalf("failed replay proposes another transition: %v %v %v", change, proof, err)
	}
}
