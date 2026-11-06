package bot_test

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type fixture struct {
	tx        pgx.Tx
	reader    store.BotReader
	writer    *botpg.Writer
	candidate model.Bot
	principal model.Principal
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	database, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	tx, err := database.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := tx.Rollback(context.Background()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error(err)
		}
	})
	owner, worker, credential := uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec(t, tx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, owner, "github:"+owner)
	exec(t, tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{"state":"unavailable","items":[]}')`, owner, worker)
	exec(t, tx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 hour')`, credential, owner, make([]byte, 32))
	return fixture{tx: tx, reader: botpg.NewReader(tx), writer: botpg.NewWriter(tx), principal: model.Principal{Kind: model.SessionCredential, UserID: owner, CredentialID: credential}, candidate: model.Bot{ID: uuid.NewString(), OwnerUserID: owner, WorkerID: worker, Name: "Storage bot", RequestFingerprint: strings.Repeat("a", 64), ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}}}
}

func exec(t *testing.T, tx pgx.Tx, sql string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func (f fixture) insert(t *testing.T, candidate model.Bot) model.Bot {
	t.Helper()
	if err := f.writer.InsertBot(t.Context(), candidate); err != nil {
		t.Fatal(err)
	}
	result, err := f.reader.Bot(t.Context(), candidate.ID)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func (f fixture) ready(t *testing.T, candidate model.Bot) model.Bot {
	t.Helper()
	current := f.insert(t, candidate)
	session, execution := uuid.NewString(), uuid.NewString()
	exec(t, f.tx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,bot_id) VALUES($1,'test',$2,$3,$4,'{}','{}',$5)`, session, execution, current.OwnerUserID, uuid.NewString(), current.ID)
	role := model.BotRoleConfiguration{Instructions: "Use the CLI.", Revision: "1", Digest: strings.Repeat("b", 64)}
	bound, err := f.writer.BindBotSession(t.Context(), current.ID, current.Version, session, role)
	if err != nil {
		t.Fatal(err)
	}
	if bound.Version != 2 || bound.SessionID == nil || *bound.SessionID != session || bound.TestExecutionID == nil || *bound.TestExecutionID != execution || !reflect.DeepEqual(bound.RoleConfiguration, &role) {
		t.Fatalf("binding lost identity or role: %+v", bound)
	}
	result, err := f.writer.SetBotStartup(t.Context(), current.ID, bound.Version, model.BotStartupResult{State: "ready"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Version != 3 || result.StartupResult.State != "ready" {
		t.Fatalf("readiness did not advance: %+v", result)
	}
	return result
}

func TestDefinitionIdentityWorkerAndCredential(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	if f.writer.BotDAO() != f.writer {
		t.Fatal("scope returned a different writer")
	}
	for _, err := range []error{f.writer.LockCreation(ctx, f.candidate.ID), f.writer.Credential(ctx, f.principal), f.writer.Worker(ctx, f.candidate.OwnerUserID, f.candidate.WorkerID), f.reader.BotWorker(ctx, f.candidate.OwnerUserID, f.candidate.WorkerID)} {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, err := range []error{f.writer.Credential(ctx, model.Principal{Kind: "unknown"}), f.writer.Credential(ctx, model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: f.principal.CredentialID}), f.writer.Worker(ctx, uuid.NewString(), f.candidate.WorkerID), f.reader.BotWorker(ctx, f.candidate.OwnerUserID, uuid.NewString())} {
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing ownership was not refused: %v", err)
		}
	}
	original := f.insert(t, f.candidate)
	if original.Version != 1 || original.CreationOrder < 1 || original.CreatedAt.IsZero() || !original.CreatedAt.Equal(original.UpdatedAt) || original.CreatedAt.Location() != time.UTC || original.UpdatedAt.Location() != time.UTC || original.SessionID != nil || original.Deletion != nil || original.StartupResult.State != "pending" || !reflect.DeepEqual(original.ResolvedConfiguration, f.candidate.ResolvedConfiguration) {
		t.Fatalf("definition round trip: %+v", original)
	}
	changed := f.candidate
	changed.Name = "Conflicting request"
	changed.RequestFingerprint = strings.Repeat("b", 64)
	if err := f.writer.InsertBot(ctx, changed); err != nil {
		t.Fatal(err)
	}
	stored, err := f.writer.Bot(ctx, original.ID)
	if err != nil || !reflect.DeepEqual(stored, original) {
		t.Fatalf("conflicting insert mutated definition: %+v, %v", stored, err)
	}
	_, err = f.reader.Bot(ctx, uuid.NewString())
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing read: %v", err)
	}
	_, err = f.writer.Bot(ctx, uuid.NewString())
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing locked read: %v", err)
	}
}

func TestInventoryPaginationAndCleanupObligations(t *testing.T) {
	f := newFixture(t)
	bots := make([]model.Bot, 3)
	for i := range bots {
		candidate := f.candidate
		candidate.ID = uuid.NewString()
		bots[i] = f.insert(t, candidate)
	}
	first, err := f.reader.Bots(t.Context(), f.candidate.OwnerUserID, &f.candidate.WorkerID, store.Page{Limit: 2})
	if err != nil || len(first.Items) != 2 || !first.HasMore {
		t.Fatalf("first page: %+v, %v", first, err)
	}
	last := first.Items[1]
	rest, err := f.reader.Bots(t.Context(), f.candidate.OwnerUserID, &f.candidate.WorkerID, store.Page{Limit: 2, After: &store.Position{CreatedAt: last.CreatedAt, ID: last.ID}})
	if err != nil || len(rest.Items) != 1 || rest.HasMore || rest.Items[0].ID == first.Items[0].ID || rest.Items[0].ID == last.ID {
		t.Fatalf("continuation: %+v, %v", rest, err)
	}
	deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 1, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	deleted, err := f.writer.SaveBotDeletion(t.Context(), bots[0].ID, deletion)
	if err != nil || deleted.Version != 2 || !reflect.DeepEqual(deleted.Deletion, deletion) {
		t.Fatalf("saved deletion: %+v, %v", deleted, err)
	}
	assertCount := func(owner string, worker *string, want int) {
		t.Helper()
		page, err := f.reader.Bots(t.Context(), owner, worker, store.Page{Limit: 10})
		if err != nil || len(page.Items) != want || page.HasMore {
			t.Fatalf("inventory want %d: %+v, %v", want, page, err)
		}
	}
	assertCount(f.candidate.OwnerUserID, nil, 2)
	assertCount(f.candidate.OwnerUserID, &f.candidate.WorkerID, 3)
	assertCount(uuid.NewString(), &f.candidate.WorkerID, 0)
	otherWorker := uuid.NewString()
	assertCount(f.candidate.OwnerUserID, &otherWorker, 0)
	deletion.WorkerCleanup.State = "completed"
	if _, err := f.writer.SaveBotDeletion(t.Context(), bots[0].ID, deletion); err != nil {
		t.Fatal(err)
	}
	assertCount(f.candidate.OwnerUserID, &f.candidate.WorkerID, 3)
	deletion.ServerCleanup.State = "completed"
	if _, err := f.writer.SaveBotDeletion(t.Context(), bots[0].ID, deletion); err != nil {
		t.Fatal(err)
	}
	assertCount(f.candidate.OwnerUserID, &f.candidate.WorkerID, 2)
	_, err = f.writer.SaveBotDeletion(t.Context(), uuid.NewString(), deletion)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing deletion: %v", err)
	}
}

func TestBindingAndStartupVersionGates(t *testing.T) {
	for _, state := range []string{"unbound", "stale", "deleted", "exhausted"} {
		t.Run(state, func(t *testing.T) {
			f := newFixture(t)
			current := f.insert(t, f.candidate)
			version := current.Version
			if state == "deleted" {
				_, err := f.writer.SaveBotDeletion(t.Context(), current.ID, &model.BotDeletion{})
				if err != nil {
					t.Fatal(err)
				}
				version++
			}
			if state == "exhausted" {
				version = math.MaxInt64
				exec(t, f.tx, `UPDATE bots SET version=$2 WHERE id=$1`, current.ID, version)
			}
			if state == "stale" {
				version++
			}
			_, err := f.writer.BindBotSession(t.Context(), current.ID, version, uuid.NewString(), model.BotRoleConfiguration{})
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("invalid binding: %v", err)
			}
			result := model.BotStartupResult{State: "failed"}
			if state == "unbound" {
				result.State = "ready"
			}
			_, err = f.writer.SetBotStartup(t.Context(), current.ID, version, result)
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("invalid startup: %v", err)
			}
		})
	}
	f := newFixture(t)
	current := f.ready(t, f.candidate)
	_, err := f.writer.BindBotSession(t.Context(), current.ID, current.Version, *current.SessionID, *current.RoleConfiguration)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("bound role overwritten: %v", err)
	}
	code := "directory_missing"
	result, err := f.writer.SetBotStartup(t.Context(), current.ID, current.Version, model.BotStartupResult{State: "failed", Code: &code})
	if err != nil || result.Version != 4 || result.StartupResult.Code == nil || *result.StartupResult.Code != code {
		t.Fatalf("failed startup round trip: %+v, %v", result, err)
	}
}

func TestPreferencesRequireReadinessAndKeepFieldWatermarks(t *testing.T) {
	f := newFixture(t)
	current := f.insert(t, f.candidate)
	if err := f.writer.CommitBotPreferences(t.Context(), current.ID); !errors.Is(err, botpg.ErrBotPreferencesNotReady) {
		t.Fatalf("unready preferences: %v", err)
	}
	empty, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
	if err != nil || empty.PreferredWorkerID != nil || len(empty.Workers) != 1 || len(empty.WorkerPreferences) != 0 || empty.ObservedAt.IsZero() || empty.ObservedAt.Location() != time.UTC {
		t.Fatalf("empty defaults: %+v, %v", empty, err)
	}
	older := f.candidate
	older.ID = uuid.NewString()
	cwd, provider := "/older", "claude"
	older.RequestedOverrides = model.BotOverrides{WorkerID: &older.WorkerID, Cwd: &cwd, Provider: &provider}
	older.ResolvedConfiguration.Cwd = cwd
	older.ResolvedConfiguration.Provider = provider
	f.ready(t, older)
	newer := older
	newer.ID = uuid.NewString()
	newProvider := "copilot"
	newer.RequestedOverrides = model.BotOverrides{Provider: &newProvider}
	newer.ResolvedConfiguration.Provider = newProvider
	f.ready(t, newer)
	if err := f.writer.CommitBotPreferences(t.Context(), newer.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.writer.CommitBotPreferences(t.Context(), older.ID); err != nil {
		t.Fatal(err)
	}
	for _, read := range []func(context.Context, string) (model.BotDefaultsInput, error){f.reader.BotDefaults, f.writer.BotDefaults} {
		defaults, err := read(t.Context(), older.OwnerUserID)
		preference := defaults.WorkerPreferences[older.WorkerID]
		if err != nil || defaults.PreferredWorkerID == nil || *defaults.PreferredWorkerID != older.WorkerID || preference.Cwd == nil || *preference.Cwd != cwd || preference.Provider == nil || *preference.Provider != newProvider {
			t.Fatalf("field watermarks: %+v, %v", defaults, err)
		}
	}
	if err := f.writer.CommitBotPreferences(t.Context(), newer.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.writer.SaveBotDeletion(t.Context(), newer.ID, &model.BotDeletion{}); err != nil {
		t.Fatal(err)
	}
	if err := f.writer.CommitBotPreferences(t.Context(), newer.ID); !errors.Is(err, botpg.ErrBotPreferencesNotReady) {
		t.Fatalf("deleted preferences: %v", err)
	}
	if err := f.writer.CommitBotPreferences(t.Context(), uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing preferences: %v", err)
	}
}

func TestCorruptStoredBotIsAnError(t *testing.T) {
	f := newFixture(t)
	f.insert(t, f.candidate)
	exec(t, f.tx, `UPDATE bots SET requested_overrides='{"workerId":42}' WHERE id=$1`, f.candidate.ID)
	_, err := f.reader.Bot(t.Context(), f.candidate.ID)
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("corruption became absence: %v", err)
	}
	_, err = f.reader.Bots(t.Context(), f.candidate.OwnerUserID, nil, store.Page{Limit: 10})
	if err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("corruption became an empty list: %v", err)
	}
}

func TestClosedTransactionErrorsRemainObservable(t *testing.T) {
	f := newFixture(t)
	if err := f.tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	operations := map[string]func() error{
		"credential":    func() error { return f.writer.Credential(t.Context(), f.principal) },
		"worker":        func() error { return f.writer.Worker(t.Context(), f.candidate.OwnerUserID, f.candidate.WorkerID) },
		"reader worker": func() error { return f.reader.BotWorker(t.Context(), f.candidate.OwnerUserID, f.candidate.WorkerID) },
		"lock":          func() error { return f.writer.LockCreation(t.Context(), f.candidate.ID) },
		"insert":        func() error { return f.writer.InsertBot(t.Context(), f.candidate) },
		"locked bot":    func() error { _, err := f.writer.Bot(t.Context(), f.candidate.ID); return err },
		"bot":           func() error { _, err := f.reader.Bot(t.Context(), f.candidate.ID); return err },
		"bots": func() error {
			_, err := f.reader.Bots(t.Context(), f.candidate.OwnerUserID, nil, store.Page{Limit: 10})
			return err
		},
		"deletion": func() error {
			_, err := f.writer.SaveBotDeletion(t.Context(), f.candidate.ID, &model.BotDeletion{})
			return err
		},
		"binding": func() error {
			_, err := f.writer.BindBotSession(t.Context(), f.candidate.ID, 1, uuid.NewString(), model.BotRoleConfiguration{})
			return err
		},
		"startup": func() error {
			_, err := f.writer.SetBotStartup(t.Context(), f.candidate.ID, 1, model.BotStartupResult{State: "failed"})
			return err
		},
		"defaults":    func() error { _, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID); return err },
		"preferences": func() error { return f.writer.CommitBotPreferences(t.Context(), f.candidate.ID) },
	}
	for name, operation := range operations {
		t.Run(name, func(t *testing.T) {
			if err := operation(); !errors.Is(err, pgx.ErrTxClosed) || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("storage error was changed: %v", err)
			}
		})
	}
}

func TestDefaultsStorageFailuresRemainErrors(t *testing.T) {
	for _, mutation := range []struct{ name, sql string }{
		{"worker preference unavailable", `DROP TABLE bot_worker_preferences`},
		{"workers unavailable", `ALTER TABLE workers RENAME TO unavailable_workers`},
		{"worker data corrupt", `UPDATE workers SET telemetry='{"machine":42}'`},
		{"configuration preference unavailable", `DROP TABLE bot_configuration_preferences`},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			f := newFixture(t)
			exec(t, f.tx, mutation.sql)
			_, err := f.reader.BotDefaults(t.Context(), f.candidate.OwnerUserID)
			if err == nil || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("broken defaults storage became absence: %v", err)
			}
		})
	}
}

func TestPreferenceWriteFailuresRemainErrors(t *testing.T) {
	for _, field := range []string{"worker", "cwd", "provider"} {
		t.Run(field, func(t *testing.T) {
			f := newFixture(t)
			candidate := f.candidate
			switch field {
			case "worker":
				candidate.RequestedOverrides.WorkerID = &candidate.WorkerID
			case "cwd":
				candidate.RequestedOverrides.Cwd = &candidate.ResolvedConfiguration.Cwd
			case "provider":
				candidate.RequestedOverrides.Provider = &candidate.ResolvedConfiguration.Provider
			}
			f.ready(t, candidate)
			table := "bot_configuration_preferences"
			if field == "worker" {
				table = "bot_worker_preferences"
			}
			exec(t, f.tx, `DROP TABLE `+table)
			if err := f.writer.CommitBotPreferences(t.Context(), candidate.ID); err == nil || errors.Is(err, botpg.ErrBotPreferencesNotReady) || errors.Is(err, model.ErrNotFound) {
				t.Fatalf("preference storage failure was hidden: %v", err)
			}
		})
	}
}
