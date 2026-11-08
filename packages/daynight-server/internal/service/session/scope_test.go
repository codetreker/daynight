package session

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type scopeTestDAO struct {
	store.SessionDAO
	calls  *[]string
	record store.SessionRecord
	botID  *string
	task   store.SessionTask
}

func (d *scopeTestDAO) LockTask(context.Context, string, string) (store.SessionTask, error) {
	*d.calls = append(*d.calls, "task")
	return d.task, nil
}
func (d *scopeTestDAO) LockCredential(_ context.Context, principal model.Principal, _ time.Time) error {
	*d.calls = append(*d.calls, "credential:"+principal.CredentialID)
	return nil
}
func (d *scopeTestDAO) ProjectAccess(context.Context, string, string) (model.ProjectAccess, error) {
	*d.calls = append(*d.calls, "project")
	return model.ProjectAccess{Role: model.ProjectAdmin}, nil
}
func (d *scopeTestDAO) SessionBotID(context.Context, string) (*string, error) {
	*d.calls = append(*d.calls, "association")
	return d.botID, nil
}
func (d *scopeTestDAO) LockSession(context.Context, string) (store.SessionRecord, error) {
	*d.calls = append(*d.calls, "session")
	return d.record, nil
}

type scopeTestBot struct {
	store.BotWriteDAO
	calls *[]string
	bot   model.Bot
}

func (d *scopeTestBot) Bot(context.Context, string) (model.Bot, error) {
	*d.calls = append(*d.calls, "bot")
	return d.bot, nil
}

type scopeTestScope struct {
	dao *scopeTestDAO
	bot *scopeTestBot
}

func (s scopeTestScope) SessionDAO() store.SessionDAO { return s.dao }
func (s scopeTestScope) BotDAO() store.BotWriteDAO    { return s.bot }

type scopeTestWriter struct{ scope scopeTestScope }

func (w scopeTestWriter) WriteSession(_ context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	if err := work(w.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestBrowserScopePreservesAdmissionAndBotLockOrder(t *testing.T) {
	for _, kind := range []string{"task", "test"} {
		t.Run(kind, func(t *testing.T) {
			var calls []string
			id, botID, testID := "session", "bot", "test"
			principal := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "browser"}
			snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: "claim"}}, Identity: sp.Identity{ProjectID: "project", TaskID: "task"}, Lifecycle: "active"}
			dao := &scopeTestDAO{calls: &calls, botID: &botID, task: store.SessionTask{Status: "in_progress", Worker: &model.WorkerClaim{ClaimID: "claim", AgentControlMode: model.AgentControlModeWeb}}}
			if kind == "task" {
				dao.botID = nil
			}
			if kind == "test" {
				snapshot.Identity.ProjectID, snapshot.Identity.TaskID, snapshot.TestExecutionID = "", "", testID
				snapshot.Identity.OwnerUserID = principal.UserID
			}
			dao.record = store.SessionRecord{Snapshot: snapshot, Owner: principal.UserID, Parent: "parent", BotID: dao.botID}
			bot := &scopeTestBot{calls: &calls, bot: model.Bot{ID: botID, OwnerUserID: principal.UserID, SessionID: &id, TestExecutionID: &testID}}
			svc := New(scopeTestWriter{scope: scopeTestScope{dao: dao, bot: bot}}, sessioncore.NewEngine(nil))
			project, task := "project", "task"
			if kind == "test" {
				project, task = "", ""
			}
			called := false
			if err := svc.browser(context.Background(), principal, project, task, id, func(*sessioncore.Access) error { called = true; return nil }); err != nil {
				t.Fatal(err)
			}
			want := []string{"task", "credential:browser", "project", "association", "session"}
			if kind == "test" {
				want = []string{"association", "bot", "session", "credential:browser", "credential:parent"}
			}
			if !called || !reflect.DeepEqual(calls, want) {
				t.Fatalf("admission: called=%v, got %v, want %v", called, calls, want)
			}
		})
	}
}
