package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	d := botDAO(f)
	if d.registration != nil || d.bindCalls != 0 || d.value.Version != bot.Version || d.value.RoleConfiguration != nil || d.value.SessionID != nil {
		t.Fatal("refused registration proposed a binding")
	}
}

func TestBotRegistrationPreservesValidModelAndArguments(t *testing.T) {
	f, bot, input := botFixture(t)
	ctx := context.Background()
	model := "native-model"
	input.Configuration.Model = &model
	input.Configuration.Args = []string{"--permission-mode", "default", ""}
	bot.ResolvedConfiguration = input.Configuration
	botDAO(f).value = bot
	result, err := f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 2, "InsertBotSession": 1, "Bot": 1, "BindBotSession": 1}), f.p, bot.WorkerID, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Bot.SessionID == nil || *result.Bot.SessionID != result.Session.SessionID || !reflect.DeepEqual(result.Bot.ResolvedConfiguration, input.Configuration) {
		t.Fatalf("registration discarded frozen model or arguments: %+v", result)
	}
	selectBotBinding(t, f, result)
	retry, err := f.s.RegisterBot(botPhase(t, f, ctx, map[string]int{"LockCredential": 3, "LockSession": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, input)
	if err != nil || retry.Session.SessionID != result.Session.SessionID {
		t.Fatalf("configured registration did not reconcile: %+v %v", retry, err)
	}
}

func TestBotRegistrationPreservesDAOFailureInsteadOfReportingMissingBot(t *testing.T) {
	f, bot, input := botFixture(t)
	failure := errors.New("Bot DAO unavailable")
	botDAO(f).BotFn = func(context.Context, string) (model.Bot, error) { return model.Bot{}, failure }
	_, err := f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 1, "Bot": 1}), f.p, bot.WorkerID, bot.ID, input)
	var businessError *model.Fault
	if !errors.Is(err, failure) || errors.As(err, &businessError) {
		t.Fatalf("DAO failure became a business refusal: %v", err)
	}
	assertBotRegistrationUnbound(t, f, bot)
	botDAO(f).BotFn = func(context.Context, string) (model.Bot, error) { return bot, nil }
	result, err := f.s.RegisterBot(botPhase(t, f, t.Context(), map[string]int{"LockCredential": 2, "InsertBotSession": 1, "Bot": 1, "BindBotSession": 1}), f.p, bot.WorkerID, bot.ID, input)
	if err != nil || result.Bot.Version != 2 || result.Bot.SessionID == nil {
		t.Fatalf("failed registration prevented valid retry: %+v %v", result, err)
	}
}
