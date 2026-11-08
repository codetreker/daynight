package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func botRegistrationValidationFixture() (*Execution, model.Principal, model.Bot, BotRegistration) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000004"}
	worker := "00000000-0000-4000-8000-000000000003"
	configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}
	bot := model.Bot{ID: "00000000-0000-4000-8000-000000000002", OwnerUserID: principal.UserID, WorkerID: worker, Version: 1, ResolvedConfiguration: configuration}
	digest := sha256.Sum256([]byte("Use Daynight CLI."))
	input := BotRegistration{BotVersion: 1, Configuration: configuration,
		RoleConfiguration: model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])},
		Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1,
			RegistrationID: "00000000-0000-4000-8000-000000000005", TestExecutionID: "00000000-0000-4000-8000-000000000006",
			ControllerID: "00000000-0000-4000-8000-000000000007", ControllerInstanceID: "00000000-0000-4000-8000-000000000008", Provider: "codex", InitialInput: "none"}}
	execution := &Execution{Engine: NewEngine(nil), botRun: func(context.Context, model.Principal, string, string, func(model.Bot) error, func(model.Bot, *Access) error, func(*Operation, store.SessionScope, model.Bot, *Access, func(model.Principal) error) error) error {
		panic("Bot registration preflight entered its runner")
	}}
	return execution, principal, bot, input
}

func TestBotRegistrationValidInputReachesRunner(t *testing.T) {
	execution, principal, bot, input := botRegistrationValidationFixture()
	ctx := t.Context()
	sentinel := errors.New("registration runner reached")
	calls := 0
	execution.botRun = func(actual context.Context, actor model.Principal, worker, id string, prepare func(model.Bot) error, existing func(model.Bot, *Access) error, work func(*Operation, store.SessionScope, model.Bot, *Access, func(model.Principal) error) error) error {
		calls++
		if actual != ctx || actor != principal || worker != bot.WorkerID || id != bot.ID || prepare == nil || existing == nil || work == nil {
			t.Fatal("valid registration changed its runner context, identity, or callbacks")
		}
		return sentinel
	}
	_, err := execution.RegisterBot(ctx, principal, bot.WorkerID, bot.ID, input)
	var refusal *model.Fault
	if calls != 1 || !errors.Is(err, sentinel) || errors.As(err, &refusal) {
		t.Fatalf("valid registration did not reach its runner once: calls=%d error=%v", calls, err)
	}
}

func TestBotRegistrationRejectsMalformedConfigurationBeforeBinding(t *testing.T) {
	for name, change := range map[string]func(*BotRegistration){
		"worker identity":  func(v *BotRegistration) { v.Configuration.WorkerID = "invalid" },
		"empty cwd":        func(v *BotRegistration) { v.Configuration.Cwd = "" },
		"cwd unicode":      func(v *BotRegistration) { v.Configuration.Cwd = string([]byte{'/', 0xff}) },
		"cwd NUL":          func(v *BotRegistration) { v.Configuration.Cwd = "/ordinary\x00directory" },
		"provider":         func(v *BotRegistration) { v.Configuration.Provider = "unknown" },
		"empty model":      func(v *BotRegistration) { value := " "; v.Configuration.Model = &value },
		"model unicode":    func(v *BotRegistration) { value := string([]byte{0xff}); v.Configuration.Model = &value },
		"model NUL":        func(v *BotRegistration) { value := "model\x00suffix"; v.Configuration.Model = &value },
		"argument unicode": func(v *BotRegistration) { v.Configuration.Args = []string{string([]byte{0xff})} },
		"argument NUL":     func(v *BotRegistration) { v.Configuration.Args = []string{"--flag\x00suffix"} },
	} {
		t.Run(name, func(t *testing.T) {
			execution, principal, bot, input := botRegistrationValidationFixture()
			change(&input)
			_, err := execution.RegisterBot(t.Context(), principal, bot.WorkerID, bot.ID, input)
			botFault(t, err, "invalid_input")
		})
	}
}

func assertBotRegistrationUnbound(t *testing.T, f fixture, bot model.Bot) {
	t.Helper()
	ctx := t.Context()
	var count int
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, bot.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid configuration created a Session: %d %v", count, err)
	}
	current, err := botservice.New(f.db).Get(ctx, f.p, bot.ID)
	if err != nil || current.Version != 1 || current.RoleConfiguration != nil || current.SessionID != nil {
		t.Fatalf("invalid configuration changed frozen binding: %+v %v", current, err)
	}
}

func TestBotRegistrationPreservesValidModelAndArguments(t *testing.T) {
	f, _, input := botFixture(t)
	ctx := context.Background()
	model := "native-model"
	input.Configuration.Model = &model
	input.Configuration.Args = []string{"--permission-mode", "default", ""}
	bot, err := botservice.New(f.db).Create(ctx, f.p, botcore.CreateBot{ID: uuid.NewString(), Name: "Configured assistant", ResolvedConfiguration: input.Configuration})
	if err != nil {
		t.Fatal(err)
	}
	result, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bot.SessionID == nil || *result.Bot.SessionID != result.Session.SessionID || !reflect.DeepEqual(result.Bot.ResolvedConfiguration, input.Configuration) {
		t.Fatalf("registration discarded frozen model or arguments: %+v", result)
	}
	retry, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
	if err != nil || retry.Session.SessionID != result.Session.SessionID {
		t.Fatalf("configured registration did not reconcile: %+v %v", retry, err)
	}
}

func TestBotRegistrationPreservesDatabaseFailureInsteadOfReportingMissingBot(t *testing.T) {
	f, bot, input := botFixture(t)
	ctx := context.Background()
	// The fixture owns its isolated schema. Temporarily remove the expected
	// relation to exercise the lifecycle's storage-error path through PostgreSQL.
	if _, err := f.db.Pool.Exec(ctx, `ALTER TABLE bots RENAME TO unavailable_bots`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := f.db.Pool.Exec(context.Background(), `ALTER TABLE IF EXISTS unavailable_bots RENAME TO bots`); err != nil {
			t.Error(err)
		}
	})
	_, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
	var pgError *pgconn.PgError
	var businessError *model.Fault
	if !errors.As(err, &pgError) || pgError.Code != "42P01" || errors.As(err, &businessError) {
		t.Fatalf("storage outage was converted to a business refusal: %v", err)
	}
	if _, err = f.db.Pool.Exec(ctx, `ALTER TABLE unavailable_bots RENAME TO bots`); err != nil {
		t.Fatal(err)
	}
	result, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
	if err != nil || result.Bot.Version != 2 || result.Bot.SessionID == nil {
		t.Fatalf("storage failure left a partial registration: %+v %v", result, err)
	}
}
