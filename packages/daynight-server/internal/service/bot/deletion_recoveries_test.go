package bot

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type recoveryListRead struct {
	store.BotWriter
	store.SnapshotScope
	store.BotReader
	t        *testing.T
	p        model.Principal
	ctx      context.Context
	page     store.BotPage
	input    store.Page
	snapshot sp.Snapshot
	err      error
	calls    []string
}

func (f *recoveryListRead) ReadSnapshot(ctx context.Context, read func(store.SnapshotScope) error) error {
	if ctx != f.ctx {
		f.t.Fatal("snapshot context changed")
	}
	f.calls = append(f.calls, "snapshot")
	return read(f)
}
func (f *recoveryListRead) BotDAO() store.BotReader               { return f }
func (f *recoveryListRead) CredentialDAO() store.CredentialReader { return f }
func (f *recoveryListRead) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	if ctx != f.ctx || p != f.p {
		f.t.Fatal("credential identity changed")
	}
	f.calls = append(f.calls, "credential")
	return store.ThreadCredential{}, nil
}
func (f *recoveryListRead) BotDeletionRecoveries(ctx context.Context, owner string, page store.Page) (store.BotPage, error) {
	if ctx != f.ctx || owner != f.p.UserID || !reflect.DeepEqual(page, f.input) {
		f.t.Fatal("page owner, context or boundary changed")
	}
	f.calls = append(f.calls, "list")
	return f.page, f.err
}
func (f *recoveryListRead) BotDeletionBinding(ctx context.Context, owner, id string) (sp.Snapshot, error) {
	if ctx != f.ctx || owner != f.p.UserID || id != f.page.Items[0].ID {
		f.t.Fatal("binding identity changed")
	}
	f.calls = append(f.calls, "binding")
	return f.snapshot, nil
}

func TestDeletionRecoveriesSnapshotAndScopes(t *testing.T) {
	p := testPrincipal()
	at := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	bot := model.Bot{ID: uuid.NewString(), OwnerUserID: p.UserID, WorkerID: uuid.NewString(), Version: 8, CreatedAt: at, SessionID: pointer(uuid.NewString()), TestExecutionID: pointer(uuid.NewString()),
		Deletion: &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 5, WorkerCleanup: model.BotCleanupResult{State: "failed", Code: pointer(botcore.MissingExecutionEvidence)}, ServerCleanup: model.BotCleanupResult{State: "pending"}}}
	snapshot := sp.Snapshot{}
	snapshot.SessionID, snapshot.TestExecutionID, snapshot.ExecutionGeneration = *bot.SessionID, *bot.TestExecutionID, "4"
	snapshot.Identity.OwnerUserID, snapshot.Identity.ControllerID, snapshot.Identity.ControllerInstanceID = p.UserID, uuid.NewString(), uuid.NewString()
	f := &recoveryListRead{t: t, p: p, ctx: t.Context(), page: store.BotPage{Items: []model.Bot{bot}, HasMore: true}, input: store.Page{Limit: 1}, snapshot: snapshot}
	source := &definitionSource{read: scopedAuthorization(t, "bot:read")}
	s, err := NewScoped(f, source)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.DeletionRecoveries(f.ctx, p, model.PageRequest{Limit: 1})
	if err != nil || len(got.Items) != 1 || !got.Items[0].RequiresStopProof || got.Items[0].OriginalBinding.SessionID != *bot.SessionID || got.NextCursor == nil || source.readScope != f {
		t.Fatalf("page: %+v %v", got, err)
	}
	if !reflect.DeepEqual(f.calls, []string{"snapshot", "credential", "list", "binding"}) {
		t.Fatalf("calls: %v", f.calls)
	}
	f.calls = nil
	source.read = scopedAuthorization(t, "session:read")
	if _, err := s.DeletionRecoveries(f.ctx, p, model.PageRequest{Limit: 1}); err == nil {
		t.Fatal("missing BotRead admitted")
	}
	if !reflect.DeepEqual(f.calls, []string{"snapshot", "credential"}) {
		t.Fatalf("work after scope refusal: %v", f.calls)
	}
	f.calls = nil
	source.read = scopedAuthorization(t, "bot:read")
	f.err = errors.New("list unavailable")
	if _, err := s.DeletionRecoveries(f.ctx, p, model.PageRequest{Limit: 1}); !errors.Is(err, f.err) {
		t.Fatalf("list failure hidden: %v", err)
	}
	if !reflect.DeepEqual(f.calls, []string{"snapshot", "credential", "list"}) {
		t.Fatalf("work after list failure: %v", f.calls)
	}
	f.calls = nil
	f.err = nil
	bot.Deletion.Recovery = &model.BotDeletionRecovery{WorkerID: bot.WorkerID, OriginalBinding: &model.BotDeletionBinding{
		SessionID: *bot.SessionID, TestExecutionID: *bot.TestExecutionID, ExecutionGeneration: "4", ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: snapshot.Identity.ControllerInstanceID},
		Decision: model.BotDeletionDecision{OperationID: uuid.NewString(), RequestedVersion: bot.Version, ActorUserID: p.UserID, Reason: "Original storage was lost.", AcknowledgedAt: at, LocalDisposition: "unverified"}}
	bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
	bot.SessionID, bot.TestExecutionID = nil, nil
	f.page = store.BotPage{Items: []model.Bot{bot}}
	got, err = s.DeletionRecoveries(f.ctx, p, model.PageRequest{Limit: 1})
	if err != nil || len(got.Items) != 1 || got.Items[0].Decision == nil || !got.Items[0].RequiresStopProof || got.Items[0].RecoveryRequired || got.NextCursor != nil {
		t.Fatalf("retained decision: %+v %v", got, err)
	}
	if !reflect.DeepEqual(f.calls, []string{"snapshot", "credential", "list"}) {
		t.Fatalf("read erased Session after decision: %v", f.calls)
	}
	f.calls = nil
	f.page = store.BotPage{}
	got, err = s.DeletionRecoveries(f.ctx, p, model.PageRequest{Limit: 1})
	if err != nil || got.Items == nil || len(got.Items) != 0 || got.NextCursor != nil {
		t.Fatalf("empty page: %+v %v", got, err)
	}
	f.calls = nil
	if _, err := s.DeletionRecoveries(f.ctx, p, model.PageRequest{Limit: 0}); err == nil || len(f.calls) != 0 {
		t.Fatalf("invalid page reached storage: %v %v", err, f.calls)
	}
}
