package sessionrelay

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestBotRegistrationRejectsMalformedConfigurationBeforeBinding(t *testing.T) {
	f, bot, original := botFixture(t)
	ctx := context.Background()
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
			input := original
			change(&input)
			_, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
			botFault(t, err, "invalid_input")
		})
	}
	var count int
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, bot.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid configuration created a Session: %d %v", count, err)
	}
	current, err := service.NewBots(f.s.DB).Get(ctx, f.p, bot.ID)
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
	bot, err := service.NewBots(f.s.DB).Create(ctx, f.p, service.CreateBot{ID: uuid.NewString(), Name: "Configured assistant", ResolvedConfiguration: input.Configuration})
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
	if _, err := f.s.DB.Pool.Exec(ctx, `ALTER TABLE bots RENAME TO unavailable_bots`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := f.s.DB.Pool.Exec(context.Background(), `ALTER TABLE IF EXISTS unavailable_bots RENAME TO bots`); err != nil {
			t.Error(err)
		}
	})
	_, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
	var pgError *pgconn.PgError
	var businessError *model.Fault
	if !errors.As(err, &pgError) || pgError.Code != "42P01" || errors.As(err, &businessError) {
		t.Fatalf("storage outage was converted to a business refusal: %v", err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `ALTER TABLE unavailable_bots RENAME TO bots`); err != nil {
		t.Fatal(err)
	}
	result, err := f.s.RegisterBot(ctx, f.p, bot.WorkerID, bot.ID, input)
	if err != nil || result.Bot.Version != 2 || result.Bot.SessionID == nil {
		t.Fatalf("storage failure left a partial registration: %+v %v", result, err)
	}
}
