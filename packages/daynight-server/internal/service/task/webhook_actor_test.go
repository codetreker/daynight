package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

const (
	sourceBotID      = "66666666-6666-4666-8666-666666666666"
	sourceOtherOwner = "77777777-7777-4777-8777-777777777777"
)

type sourceBotDAO struct {
	t     *testing.T
	calls *[]string
	bot   model.Bot
	err   error
}

func (d sourceBotDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.t.Helper()
	if id != sourceBotID {
		d.t.Fatalf("Bot barrier read %s", id)
	}
	if botID, declared := DeclaredBot(ctx); !declared || botID != sourceBotID {
		d.t.Fatal("Bot barrier lost the request declaration")
	}
	*d.calls = append(*d.calls, "bot")
	return d.bot, d.err
}

func sourceBotCases() []struct {
	name string
	bot  model.Bot
	err  error
	code string
} {
	deleted := &model.BotDeletion{}
	failure := errors.New("Bot barrier failed")
	return []struct {
		name string
		bot  model.Bot
		err  error
		code string
	}{
		{name: "own live Bot", bot: model.Bot{ID: sourceBotID, OwnerUserID: sourceUserID}},
		{name: "missing Bot", err: model.ErrNotFound, code: "forbidden"},
		{name: "foreign Bot", bot: model.Bot{ID: sourceBotID, OwnerUserID: sourceOtherOwner}, code: "forbidden"},
		{name: "deleted Bot", bot: model.Bot{ID: sourceBotID, OwnerUserID: sourceUserID, Deletion: deleted}, code: "forbidden"},
		{name: "barrier failure", err: failure},
	}
}

func TestSourceActorWithoutDeclarationIsTheCredentialUser(t *testing.T) {
	scope := sourceWriteScope{tasks: &sourceTaskDAO{t: t}}
	actor, err := sourceActor(t.Context(), scope, sourcePrincipal())
	if err != nil || actor != wm.UserActor(sourceUserID) {
		t.Fatalf("undeclared actor = %+v, %v", actor, err)
	}
}

func TestTaskWriteVerifiesDeclaredBotBeforeSessionsAndCapture(t *testing.T) {
	for _, tc := range sourceBotCases() {
		t.Run(tc.name, func(t *testing.T) {
			current := sourceTask(model.TaskTodo)
			updated := current
			updated.Status, updated.Version, updated.UpdatedAt = model.TaskInProgress, 8, current.UpdatedAt.Add(time.Second)
			db, record, ctx, calls := newSourceWrite(t, current, updated)
			ctx = WithDeclaredBot(ctx, sourceBotID)
			db.ctx = ctx
			db.scope.bots = sourceBotDAO{t: t, calls: calls, bot: tc.bot, err: tc.err}
			want := wm.BotActor(sourceUserID, sourceBotID)
			record.actor = &want
			_, err := NewTasks(db, record).SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 7, Status: model.TaskInProgress})
			if tc.code == "" && tc.err == nil {
				if err != nil || !reflect.DeepEqual(*calls, []string{"bot", "update", "drain", "receipts", "capture"}) {
					t.Fatalf("Bot-attributed status write: %v %v", err, *calls)
				}
				return
			}
			var fault *model.Fault
			switch {
			case tc.code != "" && (!errors.As(err, &fault) || fault.Code != tc.code):
				t.Fatalf("declared Bot refusal = %v, want %s", err, tc.code)
			case tc.err != nil && tc.code == "" && !errors.Is(err, tc.err):
				t.Fatalf("Bot barrier failure was not propagated: %v", err)
			}
			if !reflect.DeepEqual(*calls, []string{"bot"}) || len(record.calls) != 0 {
				t.Fatalf("refused Bot continued the write: %v %v", *calls, record.calls)
			}
		})
	}
}

func TestTaskWriteRejectsNoncanonicalDeclaredBotWithoutBarrierRead(t *testing.T) {
	current := sourceTask(model.TaskTodo)
	db, record, ctx, calls := newSourceWrite(t, current, model.Task{})
	ctx = WithDeclaredBot(ctx, "66666666-6666-4666-8666-66666666666A")
	db.ctx = ctx
	db.scope.bots = sourceBotDAO{t: t, calls: calls}
	_, err := NewTasks(db, record).SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 7, Status: model.TaskInProgress})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" || len(*calls) != 0 || len(record.calls) != 0 {
		t.Fatalf("noncanonical Bot: %v %v", err, *calls)
	}
}

func TestThreadWriteVerifiesDeclaredBotAfterProjectAuthorization(t *testing.T) {
	for _, tc := range sourceBotCases() {
		t.Run(tc.name, func(t *testing.T) {
			calls := []string{}
			marker := &sourceCaptureDAO{}
			record := &sourceCapture{t: t, dao: marker, trace: &calls}
			ctx := WithDeclaredBot(context.WithValue(t.Context(), sourceContextKey{}, record), sourceBotID)
			reply := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			scope := replySourceScope{tasks: replySourceTaskDAO{t: t, calls: &calls}, credentials: replySourceCredentialDAO{t: t, calls: &calls}, projects: replySourceProjectDAO{t: t, calls: &calls}, messages: replySourceMessageDAO{t: t, calls: &calls, reply: reply}, capture: marker, bots: sourceBotDAO{t: t, calls: &calls, bot: tc.bot, err: tc.err}}
			database := threadSourceStore{t: t, ctx: ctx, work: func(_ context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
				return store.Completion{Outcome: store.TransactionNotCommitted}, fn(scope)
			}}
			_, err := NewTaskThreads(database, record).Post(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, CreateThreadMessage{Body: "Reply", ReplyTo: &reply})
			order := []string{"presence", "credential", "authorization", "bot"}
			code := tc.code
			if tc.code == "" && tc.err == nil {
				// The admitted Bot lets the write continue to its own reply refusal.
				order, code = append(order, "name", "head", "reply"), "message_not_found"
			}
			var fault *model.Fault
			if code != "" && (!errors.As(err, &fault) || fault.Code != code) || tc.err != nil && code == "" && !errors.Is(err, tc.err) {
				t.Fatalf("thread Bot admission = %v, want %s", err, code)
			}
			if !reflect.DeepEqual(calls, order) || len(record.calls) != 0 {
				t.Fatalf("thread Bot admission order: %v %v", calls, record.calls)
			}
		})
	}
}
