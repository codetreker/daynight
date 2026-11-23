package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestDeletionRecoveryReadOwnsSnapshotAndAdmission(t *testing.T) {
	p, bot, input := deletionResolutionIdentity()
	bot.SessionID = pointer(uuid.NewString())
	bot.TestExecutionID = pointer(uuid.NewString())
	f := &recoveryListRead{t: t, p: p, ctx: t.Context(), page: store.BotPage{Items: []model.Bot{bot}}}
	f.snapshot.SessionID, f.snapshot.TestExecutionID, f.snapshot.ExecutionGeneration = *bot.SessionID, *bot.TestExecutionID, "3"
	f.snapshot.Identity.OwnerUserID, f.snapshot.Identity.ControllerID, f.snapshot.Identity.ControllerInstanceID = p.UserID, uuid.NewString(), uuid.NewString()
	source := &definitionSource{read: scopedAuthorization(t, "bot:read")}
	s, err := NewScoped(f, source)
	if err != nil {
		t.Fatal(err)
	}
	s.operations.get = func(ctx context.Context, scope store.SnapshotScope, principal model.Principal, id string) (model.Bot, error) {
		identical(t, ctx, f.ctx)
		identical(t, scope, f)
		same(t, principal, p)
		same(t, id, bot.ID)
		f.calls = append(f.calls, "get")
		return bot, nil
	}
	result, err := s.DeletionRecovery(f.ctx, p, bot.ID)
	if err != nil || !result.RequiresStopProof || result.OriginalBinding.ExecutionGeneration != "3" || !result.RecoveryRequired {
		t.Fatalf("read: %+v %v", result, err)
	}
	same(t, f.calls, []string{"snapshot", "get", "binding"})
	f.calls = nil
	source.read = scopedAuthorization(t, "session:read")
	_, err = s.DeletionRecovery(f.ctx, p, bot.ID)
	if err == nil {
		t.Fatal("scope refused after private binding read")
	}
	same(t, f.calls, []string{"snapshot", "get"})
	f.calls = nil
	source.read = scopedAuthorization(t, "bot:read")
	binding, err := botcore.DeletionBinding(bot, &f.snapshot)
	if err != nil {
		t.Fatal(err)
	}
	botcore.ApplyDeletionResolution(&bot, input, binding, time.Now())
	bot.Deletion.ServerCleanup.State = "completed"
	bot.SessionID, bot.TestExecutionID = nil, nil
	result, err = s.DeletionRecovery(f.ctx, p, bot.ID)
	if err != nil || result.Decision == nil || !reflect.DeepEqual(result.OriginalBinding, binding) {
		t.Fatalf("retained: %+v %v", result, err)
	}
	same(t, f.calls, []string{"snapshot", "get"})
	f.calls = nil
	bot.Deletion = nil
	_, err = s.DeletionRecovery(f.ctx, p, bot.ID)
	requireFault(t, err, "resource_conflict")
	f.calls = nil
	_, err = s.DeletionRecovery(f.ctx, p, "bad")
	if err == nil || len(f.calls) != 0 {
		t.Fatal("bad ID read storage")
	}
	_, err = s.DeletionRecovery(f.ctx, model.Principal{}, bot.ID)
	if err == nil || len(f.calls) != 0 {
		t.Fatal("bad principal read storage")
	}
	s.operations.get = func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error) {
		return model.Bot{}, model.ErrNotFound
	}
	_, err = s.DeletionRecovery(f.ctx, p, bot.ID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("read cause: %v", err)
	}
}
