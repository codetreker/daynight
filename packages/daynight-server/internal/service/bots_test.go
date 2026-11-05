package service

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/google/uuid"
)

func botService(t *testing.T) (*Bots, *store.Store, model.Principal, string) {
	t.Helper()
	database, err := store.Open(context.Background(), serviceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	principal := servicePrincipal(t, database)
	workerID := uuid.NewString()
	if _, err := NewWorkers(database).Report(context.Background(), principal, workerID, serviceWorkerReport()); err != nil {
		t.Fatal(err)
	}
	return NewBots(database), database, principal, workerID
}

func botInput(workerID string) CreateBot {
	return CreateBot{ID: uuid.NewString(), Name: "助手", ResolvedConfiguration: model.BotConfiguration{WorkerID: workerID, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}}
}

func TestBotsCreateOnceWithoutProjectAndPreserveFrozenConfiguration(t *testing.T) {
	bots, database, principal, workerID := botService(t)
	ctx := context.Background()
	input := botInput(workerID)
	input.Name = "  助手  "
	created, err := bots.Create(ctx, principal, input)
	if err != nil {
		t.Fatal(err)
	}
	if created.Name != "助手" || created.Version != 1 || created.CreationOrder < 1 || created.OwnerUserID != principal.UserID || created.WorkerID != workerID || created.SessionID != nil || created.RoleConfiguration != nil || created.StartupResult.State != "pending" || created.Deletion != nil {
		t.Fatalf("invalid fresh definition: %+v", created)
	}
	var projects int
	if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM projects").Scan(&projects); err != nil || projects != 0 {
		t.Fatalf("Bot created a project: %d %v", projects, err)
	}
	input.ID = strings.ToUpper(input.ID)
	input.Name = "助手"
	input.ResolvedConfiguration.Cwd = "/new/default"
	replayed, err := bots.Create(ctx, principal, input)
	if err != nil || !reflect.DeepEqual(created, replayed) {
		t.Fatalf("replay changed frozen result: %+v %v", replayed, err)
	}
	input.Name = "different"
	_, err = bots.Create(ctx, principal, input)
	requireFault(t, err, "resource_conflict")
	input.Name = "助手"
	input.Overrides.WorkerID = &workerID
	_, err = bots.Create(ctx, principal, input)
	requireFault(t, err, "resource_conflict")
}

func TestBotsDeletionIntentIsVersionedAndIdempotent(t *testing.T) {
	bots, _, principal, workerID := botService(t)
	ctx := context.Background()
	bot, err := bots.Create(ctx, principal, botInput(workerID))
	if err != nil {
		t.Fatal(err)
	}
	request := DeleteBot{Version: bot.Version, DeletionID: uuid.NewString()}
	deleted, err := bots.Delete(ctx, principal, bot.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if deleted.Version != 2 || deleted.Deletion == nil || deleted.Deletion.RequestedVersion != 1 || deleted.Deletion.DeletionID != request.DeletionID || deleted.Deletion.WorkerCleanup.State != "pending" || deleted.Deletion.ServerCleanup.State != "pending" {
		t.Fatalf("incorrect deletion: %+v", deleted)
	}
	replayed, err := bots.Delete(ctx, principal, bot.ID, request)
	if err != nil || !reflect.DeepEqual(deleted, replayed) {
		t.Fatalf("deletion replay: %+v %v", replayed, err)
	}
	request.Version = 2
	_, err = bots.Delete(ctx, principal, bot.ID, request)
	requireFault(t, err, "resource_conflict")
	page, err := bots.List(ctx, principal, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("deleted Bot remained visible: %+v %v", page, err)
	}
	page, err = bots.ListWorker(ctx, principal, workerID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Deletion == nil {
		t.Fatalf("worker lost cleanup obligation: %+v %v", page, err)
	}
}

func TestBotsRejectForeignOwnersWorkersAndRevokedCredentials(t *testing.T) {
	bots, database, principal, workerID := botService(t)
	ctx := context.Background()
	input := botInput(workerID)
	bot, err := bots.Create(ctx, principal, input)
	if err != nil {
		t.Fatal(err)
	}
	other := servicePrincipal(t, database)
	_, err = bots.Get(ctx, other, bot.ID)
	requireFault(t, err, "forbidden")
	_, err = bots.Create(ctx, other, input)
	requireFault(t, err, "forbidden")
	_, err = bots.Create(ctx, other, botInput(workerID))
	requireFault(t, err, "forbidden")
	_, err = bots.Delete(ctx, other, bot.ID, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
	requireFault(t, err, "forbidden")
	_, err = bots.ListWorker(ctx, other, workerID, model.PageRequest{Limit: 10})
	requireFault(t, err, "forbidden")
	if _, err := database.Pool.Exec(ctx, "DELETE FROM sessions WHERE id=$1", principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = bots.Get(ctx, principal, bot.ID)
	requireFault(t, err, "unauthenticated")
	_, err = bots.Create(ctx, principal, botInput(workerID))
	requireFault(t, err, "unauthenticated")
	_, err = bots.Delete(ctx, principal, bot.ID, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
	requireFault(t, err, "unauthenticated")
	_, err = bots.List(ctx, principal, model.PageRequest{Limit: 10})
	requireFault(t, err, "unauthenticated")
}

func TestBotsRejectCredentialsExpiringDuringDefinitionLockWait(t *testing.T) {
	for _, operation := range []string{"create", "delete"} {
		t.Run(operation, func(t *testing.T) {
			bots, database, principal, workerID := botService(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			input := botInput(workerID)
			bot, err := bots.Create(ctx, principal, input)
			if err != nil {
				t.Fatal(err)
			}
			lock, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Rollback(ctx)
			if _, err := lock.Exec(ctx, "SELECT id FROM bots WHERE id=$1 FOR UPDATE", bot.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := database.Pool.Exec(ctx, "UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", principal.CredentialID); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				if operation == "create" {
					_, err := bots.Create(ctx, principal, input)
					result <- err
				} else {
					_, err := bots.Delete(ctx, principal, bot.ID, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
					result <- err
				}
			}()
			threadWait(t, ctx, func() (bool, error) {
				var waiting bool
				err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%FROM bots WHERE id=$1 FOR UPDATE%')`).Scan(&waiting)
				return waiting, err
			})
			threadWait(t, ctx, func() (bool, error) {
				var expired bool
				err := database.Pool.QueryRow(ctx, "SELECT expires_at<=clock_timestamp() FROM sessions WHERE id=$1", principal.CredentialID).Scan(&expired)
				return expired, err
			})
			if err := lock.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				requireFault(t, err, "unauthenticated")
			case <-time.After(5 * time.Second):
				t.Fatal("Bot operation did not finish after releasing its lock")
			}
			var version int64
			if err := database.Pool.QueryRow(ctx, "SELECT version FROM bots WHERE id=$1", bot.ID).Scan(&version); err != nil || version != 1 {
				t.Fatalf("expired credential changed Bot: %d %v", version, err)
			}
		})
	}
}

func TestBotsConcurrentCreationAndDeletionChooseOneIdentity(t *testing.T) {
	bots, database, principal, workerID := botService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	input := botInput(workerID)
	type outcome struct {
		bot model.Bot
		err error
	}
	results := make(chan outcome, 8)
	for range 8 {
		go func() { bot, err := bots.Create(ctx, principal, input); results <- outcome{bot, err} }()
	}
	var first model.Bot
	for index := range 8 {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		if index == 0 {
			first = got.bot
		} else if !reflect.DeepEqual(first, got.bot) {
			t.Fatal("concurrent replay produced another result")
		}
	}
	var count int
	if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM bots").Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate definitions: %d %v", count, err)
	}
	deletion := DeleteBot{Version: first.Version, DeletionID: uuid.NewString()}
	for range 8 {
		go func() { bot, err := bots.Delete(ctx, principal, input.ID, deletion); results <- outcome{bot, err} }()
	}
	for range 8 {
		got := <-results
		if got.err != nil || got.bot.Version != 2 || got.bot.Deletion == nil || got.bot.Deletion.DeletionID != deletion.DeletionID {
			t.Fatalf("concurrent deletion: %+v %v", got.bot, got.err)
		}
	}
	input.Name = "another request"
	_, err := bots.Create(ctx, principal, input)
	requireFault(t, err, "resource_conflict")
	input.Name = "助手"
	replayed, err := bots.Create(ctx, principal, input)
	if err != nil || replayed.Deletion == nil || replayed.Version != 2 {
		t.Fatalf("creation replay resurrected deletion: %+v %v", replayed, err)
	}
}

func TestBotsPaginationAndCompositeWorkerIdentity(t *testing.T) {
	bots, database, principal, workerID := botService(t)
	ctx := context.Background()
	other := servicePrincipal(t, database)
	if _, err := NewWorkers(database).Report(ctx, other, workerID, serviceWorkerReport()); err != nil {
		t.Fatal(err)
	}
	foreign, err := bots.Create(ctx, other, botInput(workerID))
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := bots.Create(ctx, principal, botInput(workerID)); err != nil {
			t.Fatal(err)
		}
	}
	request := model.PageRequest{Limit: 1}
	seen := map[string]bool{}
	for range 3 {
		page, err := bots.List(ctx, principal, request)
		if err != nil || len(page.Items) != 1 || seen[page.Items[0].ID] || page.Items[0].ID == foreign.ID {
			t.Fatalf("invalid page: %+v %v", page, err)
		}
		seen[page.Items[0].ID] = true
		if page.NextCursor != nil {
			_, err = bots.List(ctx, other, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
			requireFault(t, err, "invalid_input")
			_, err = bots.ListWorker(ctx, principal, workerID, model.PageRequest{Limit: 1, Cursor: page.NextCursor})
			requireFault(t, err, "invalid_input")
		}
		request.Cursor = page.NextCursor
	}
	if request.Cursor != nil || len(seen) != 3 {
		t.Fatalf("incomplete pages: %+v", seen)
	}
	page, err := bots.ListWorker(ctx, principal, strings.ToUpper(workerID), model.PageRequest{Limit: 2})
	if err != nil || len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("worker page: %+v %v", page, err)
	}
	page, err = bots.ListWorker(ctx, principal, workerID, model.PageRequest{Limit: 2, Cursor: page.NextCursor})
	if err != nil || len(page.Items) != 1 || page.NextCursor != nil {
		t.Fatalf("worker tail: %+v %v", page, err)
	}
}

func TestBotsVersionsBoundSessionAndIndependentTasks(t *testing.T) {
	bots, database, principal, workerID := botService(t)
	ctx := context.Background()
	project, err := NewProjects(database).Create(ctx, principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Independent tasks", RepoURL: "https://github.com/example/independent"})
	if err != nil {
		t.Fatal(err)
	}
	tasks := NewTasks(database)
	task, err := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "A task stays independent"})
	if err != nil {
		t.Fatal(err)
	}
	before := stepsStoredState(t, database, task.ID, false)
	bot, err := bots.Create(ctx, principal, botInput(workerID))
	if err != nil {
		t.Fatal(err)
	}
	request := DeleteBot{Version: 2, DeletionID: uuid.NewString()}
	_, err = bots.Delete(ctx, principal, bot.ID, request)
	requireFault(t, err, "version_conflict")
	if _, err := database.Pool.Exec(ctx, "UPDATE bots SET version=9007199254740993,session_id=$2 WHERE id=$1", bot.ID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	request.Version = 9007199254740993
	_, err = bots.Delete(ctx, principal, bot.ID, request)
	requireFault(t, err, "resource_conflict")
	if _, err := database.Pool.Exec(ctx, "UPDATE bots SET session_id=NULL WHERE id=$1", bot.ID); err != nil {
		t.Fatal(err)
	}
	deleted, err := bots.Delete(ctx, principal, bot.ID, request)
	if err != nil || deleted.Version != 9007199254740994 || deleted.Deletion.RequestedVersion != 9007199254740993 {
		t.Fatalf("version lost precision: %+v %v", deleted, err)
	}
	if after := stepsStoredState(t, database, task.ID, false); before != after {
		t.Fatal("Bot deletion mutated an independent Task")
	}
	bot, err = bots.Create(ctx, principal, botInput(workerID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE bots SET version=9223372036854775807 WHERE id=$1", bot.ID); err != nil {
		t.Fatal(err)
	}
	_, err = bots.Delete(ctx, principal, bot.ID, DeleteBot{Version: math.MaxInt64, DeletionID: uuid.NewString()})
	requireFault(t, err, "version_exhausted")
}

func TestBotsPATLifecycleAndCompletedCleanupInventory(t *testing.T) {
	bots, database, browser, workerID := botService(t)
	ctx := context.Background()
	identity := identityservice.New(database, nil, "")
	token, err := identity.CreatePAT(ctx, browser, identitycore.CreatePAT{Name: "Bot owner"})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := identity.Authenticate(ctx, model.PATCredential, token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	bot, err := bots.Create(ctx, principal, botInput(workerID))
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := bots.Delete(ctx, principal, bot.ID, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE bots SET deletion=jsonb_set(jsonb_set(deletion,'{workerCleanup,state}','"completed"'),'{serverCleanup,state}','"completed"') WHERE id=$1`, bot.ID); err != nil {
		t.Fatal(err)
	}
	page, err := bots.ListWorker(ctx, principal, workerID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("completed responsibility remained scheduled: %+v %v", page, err)
	}
	replayed, err := bots.Delete(ctx, principal, bot.ID, DeleteBot{Version: 1, DeletionID: deleted.Deletion.DeletionID})
	if err != nil || replayed.Deletion.WorkerCleanup.State != "completed" {
		t.Fatalf("replay reset cleanup: %+v %v", replayed, err)
	}
	if err := identity.RevokePAT(ctx, browser, token.Credential.ID); err != nil {
		t.Fatal(err)
	}
	_, err = bots.Get(ctx, principal, bot.ID)
	requireFault(t, err, "unauthenticated")
	_, err = bots.Create(ctx, principal, botInput(workerID))
	requireFault(t, err, "unauthenticated")
}

func TestBotsValidateDefinitionsAndRequests(t *testing.T) {
	bots, database, principal, workerID := botService(t)
	ctx := context.Background()
	for _, test := range []struct {
		name   string
		change func(*CreateBot)
	}{
		{"invalid ID", func(v *CreateBot) { v.ID = "invalid" }},
		{"empty name", func(v *CreateBot) { v.Name = "   " }},
		{"long name", func(v *CreateBot) { v.Name = strings.Repeat("界", 41) }},
		{"control name", func(v *CreateBot) { v.Name = "\tName" }},
		{"invalid Unicode", func(v *CreateBot) { v.Name = string([]byte{0xff}) }},
		{"override Worker", func(v *CreateBot) { v.Overrides.WorkerID = pointer("invalid") }},
		{"relative override", func(v *CreateBot) { v.Overrides.Cwd = pointer("relative") }},
		{"override provider", func(v *CreateBot) { v.Overrides.Provider = pointer("unsupported") }},
		{"invalid resolved Worker", func(v *CreateBot) { v.ResolvedConfiguration.WorkerID = "invalid" }},
		{"relative directory", func(v *CreateBot) { v.ResolvedConfiguration.Cwd = "relative" }},
		{"directory control", func(v *CreateBot) { v.ResolvedConfiguration.Cwd = "/foo\nbar" }},
		{"invalid provider", func(v *CreateBot) { v.ResolvedConfiguration.Provider = "unsupported" }},
		{"empty model", func(v *CreateBot) { v.ResolvedConfiguration.Model = pointer("  ") }},
		{"invalid model", func(v *CreateBot) { v.ResolvedConfiguration.Model = pointer("model\x00") }},
		{"invalid arg", func(v *CreateBot) { v.ResolvedConfiguration.Args = []string{"--model", "value\x00"} }},
		{"changed explicit Worker", func(v *CreateBot) { v.Overrides.WorkerID = pointer(uuid.NewString()) }},
		{"changed explicit directory", func(v *CreateBot) { v.Overrides.Cwd = pointer("/explicit") }},
		{"changed explicit provider", func(v *CreateBot) { v.Overrides.Provider = pointer("claude") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := botInput(workerID)
			test.change(&input)
			_, err := bots.Create(ctx, principal, input)
			requireFault(t, err, "invalid_input")
		})
	}
	for _, cwd := range []string{"/normal", `C:\ordinary\directory`, `D:/ordinary`, `\\machine\share\directory`} {
		input := botInput(workerID)
		input.Name = strings.Repeat("界", 40)
		input.ResolvedConfiguration.Cwd = cwd
		input.ResolvedConfiguration.Args = nil
		upper := strings.ToUpper(workerID)
		input.Overrides = model.BotOverrides{WorkerID: &upper, Cwd: &cwd, Provider: pointer("codex")}
		bot, err := bots.Create(ctx, principal, input)
		if err != nil || bot.RequestedOverrides.WorkerID == nil || *bot.RequestedOverrides.WorkerID != workerID || bot.ResolvedConfiguration.Args == nil {
			t.Fatalf("valid definition failed: %+v %v", bot, err)
		}
	}
	id := uuid.NewString()
	for _, operation := range []func() error{
		func() error { _, err := bots.Create(ctx, model.Principal{}, botInput(workerID)); return err },
		func() error { _, err := bots.Get(ctx, model.Principal{}, id); return err },
		func() error { _, err := bots.List(ctx, model.Principal{}, model.PageRequest{Limit: 10}); return err },
		func() error {
			_, err := bots.Delete(ctx, model.Principal{}, id, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
			return err
		},
	} {
		requireFault(t, operation(), "unauthenticated")
	}
	for _, operation := range []func() error{
		func() error { _, err := bots.Get(ctx, principal, "bad"); return err },
		func() error {
			_, err := bots.ListWorker(ctx, principal, "bad", model.PageRequest{Limit: 10})
			return err
		},
		func() error { _, err := bots.List(ctx, principal, model.PageRequest{Limit: 0}); return err },
		func() error {
			_, err := bots.List(ctx, principal, model.PageRequest{Limit: 10, Cursor: pointer("broken")})
			return err
		},
		func() error {
			_, err := bots.Delete(ctx, principal, "bad", DeleteBot{Version: 1, DeletionID: id})
			return err
		},
		func() error {
			_, err := bots.Delete(ctx, principal, id, DeleteBot{Version: 1, DeletionID: "bad"})
			return err
		},
		func() error {
			_, err := bots.Delete(ctx, principal, id, DeleteBot{Version: 0, DeletionID: id})
			return err
		},
	} {
		requireFault(t, operation(), "invalid_input")
	}
	_, err := bots.Get(ctx, principal, id)
	requireFault(t, err, "not_found")
	_, err = bots.Delete(ctx, principal, id, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
	requireFault(t, err, "not_found")
	database.Close()
	for _, operation := range []func() error{
		func() error { _, err := bots.Get(ctx, principal, id); return err },
		func() error { _, err := bots.List(ctx, principal, model.PageRequest{Limit: 10}); return err },
		func() error {
			_, err := bots.Delete(ctx, principal, id, DeleteBot{Version: 1, DeletionID: uuid.NewString()})
			return err
		},
		func() error { _, err := bots.Create(ctx, principal, botInput(workerID)); return err },
	} {
		err := operation()
		var failure *model.BotOperationError
		if !errors.As(err, &failure) {
			t.Fatalf("database failure lost operational identity: %v", err)
		}
	}
}

func TestBotOperationErrorsPreserveUncertainAndJoinedFailures(t *testing.T) {
	refusal := botForbidden()
	for _, transaction := range []*store.TransactionError{
		{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "cleanup", Cause: refusal, Outcome: store.TransactionUnknown, CleanupFailed: true},
		{Phase: "operation", Cause: errors.Join(refusal, errors.New("another failure")), Outcome: store.TransactionNotCommitted},
	} {
		err := botResultError("create", transaction)
		var failure *model.BotOperationError
		if !errors.As(err, &failure) || !errors.Is(err, transaction) || err.Error() == "" {
			t.Fatalf("uncertain error became confirmed refusal: %v", err)
		}
	}
}
