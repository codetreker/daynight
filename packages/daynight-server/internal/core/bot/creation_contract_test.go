package bot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type creationContractDAO struct {
	store.BotWriteDAO
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	steps     []string
	candidate model.Bot
	result    model.Bot
	defaults  model.BotDefaultsInput
	reads     int
}

func (d *creationContractDAO) called(ctx context.Context, name string) {
	d.t.Helper()
	if ctx != d.ctx || len(d.steps) == 0 || d.steps[0] != name {
		d.t.Fatalf("unexpected %s: context matches=%v, remaining=%v", name, ctx == d.ctx, d.steps)
	}
	d.steps = d.steps[1:]
}
func (d *creationContractDAO) Credential(ctx context.Context, p model.Principal) error {
	d.called(ctx, "credential")
	if p != d.principal {
		d.t.Fatalf("credential principal: %+v; want %+v", p, d.principal)
	}
	return nil
}
func (d *creationContractDAO) LockCreation(ctx context.Context, id string) error {
	d.called(ctx, "lock")
	if id != d.candidate.ID {
		d.t.Fatalf("creation lock: %q", id)
	}
	return nil
}
func (d *creationContractDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	d.called(ctx, "bot")
	if id != d.candidate.ID {
		d.t.Fatalf("Bot ID: %q", id)
	}
	d.reads++
	if d.reads == 1 {
		return model.Bot{}, model.ErrNotFound
	}
	return cloneContractBot(d.result), nil
}
func (d *creationContractDAO) Worker(ctx context.Context, owner, worker string) error {
	d.called(ctx, "worker")
	if owner != d.principal.UserID || worker != d.candidate.WorkerID {
		d.t.Fatalf("Worker scope: %q %q", owner, worker)
	}
	return nil
}
func (d *creationContractDAO) InsertBot(ctx context.Context, value model.Bot) error {
	d.called(ctx, "insert")
	if !reflect.DeepEqual(value, d.candidate) {
		d.t.Fatalf("creation candidate:\n got %#v\nwant %#v", value, d.candidate)
	}
	return nil
}
func (d *creationContractDAO) BotPreferredWorker(ctx context.Context, owner string) (*string, error) {
	d.called(ctx, "preferred")
	if owner != d.principal.UserID {
		d.t.Fatalf("preferred owner: %q", owner)
	}
	return nil, nil
}
func (d *creationContractDAO) BotCreationCandidates(ctx context.Context, owner string) (model.BotDefaultsInput, error) {
	d.called(ctx, "candidates")
	if owner != d.principal.UserID {
		d.t.Fatalf("candidates owner: %q", owner)
	}
	return d.defaults, nil
}
func (d *creationContractDAO) BotCreationWorker(ctx context.Context, owner, worker string) (model.BotDefaultsInput, error) {
	d.called(ctx, "configuration")
	if owner != d.principal.UserID || worker != d.candidate.WorkerID {
		d.t.Fatalf("configuration scope: %q %q", owner, worker)
	}
	return d.defaults, nil
}

func cloneContractBot(value model.Bot) model.Bot {
	copyString := func(value *string) *string {
		if value == nil {
			return nil
		}
		result := *value
		return &result
	}
	value.RequestedOverrides.WorkerID = copyString(value.RequestedOverrides.WorkerID)
	value.RequestedOverrides.Cwd = copyString(value.RequestedOverrides.Cwd)
	value.RequestedOverrides.Provider = copyString(value.RequestedOverrides.Provider)
	value.RequestedOverrides.Model = copyString(value.RequestedOverrides.Model)
	value.RequestedOverrides.ReasoningEffort = copyString(value.RequestedOverrides.ReasoningEffort)
	value.ResolvedConfiguration.Model = copyString(value.ResolvedConfiguration.Model)
	value.ResolvedConfiguration.ReasoningEffort = copyString(value.ResolvedConfiguration.ReasoningEffort)
	if value.ResolvedConfiguration.Args != nil {
		value.ResolvedConfiguration.Args = append([]string{}, value.ResolvedConfiguration.Args...)
	}
	if value.ResolvedConfiguration.Selection != nil {
		result := *value.ResolvedConfiguration.Selection
		value.ResolvedConfiguration.Selection = &result
	}
	if value.RoleConfiguration != nil {
		result := *value.RoleConfiguration
		value.RoleConfiguration = &result
	}
	value.SessionID = copyString(value.SessionID)
	value.TestExecutionID = copyString(value.TestExecutionID)
	value.StartupResult.Code = copyString(value.StartupResult.Code)
	if value.Deletion != nil {
		result := *value.Deletion
		result.WorkerCleanup.Code = copyString(result.WorkerCleanup.Code)
		result.ServerCleanup.Code = copyString(result.ServerCleanup.Code)
		value.Deletion = &result
	}
	return value
}

func contractFingerprint(t *testing.T, name string, overrides model.BotOverrides) string {
	t.Helper()
	raw, err := json.Marshal(struct {
		Name      string             `json:"name"`
		Overrides model.BotOverrides `json:"overrides"`
	}{name, overrides})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func TestCreationPreservesMCPDefaultsAndExplicitOverride(t *testing.T) {
	now := time.Date(2026, 11, 11, 1, 2, 3, 4000, time.UTC)
	principal := model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
	const worker = "b5555555-5555-4555-8555-555555555555"
	for _, explicit := range []bool{false, true} {
		name := "defaults"
		if explicit {
			name = "explicit"
		}
		t.Run(name, func(t *testing.T) {
			configuration := model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "copilot", Model: ptr("gpt-5"), Args: []string{"--effort", "high"}}
			in := CreateBot{ID: botID, Name: "Assistant"}
			steps := []string{"credential", "lock", "bot", "preferred", "candidates", "configuration", "worker", "insert", "bot", "credential"}
			if explicit {
				in.ID, in.Name = "c6666666-6666-4666-8666-666666666666", "Second"
				in.Overrides = model.BotOverrides{WorkerID: ptr(worker), Cwd: ptr("/chosen"), Provider: ptr("codex")}
				configuration = model.BotConfiguration{WorkerID: worker, Cwd: "/chosen", Provider: "codex", Args: []string{}}
				steps = []string{"credential", "lock", "bot", "configuration", "worker", "insert", "bot", "credential"}
			}
			fingerprint := contractFingerprint(t, in.Name, in.Overrides)
			want := model.Bot{ID: in.ID, OwnerUserID: principal.UserID, WorkerID: worker, Name: in.Name, Version: 1, CreationOrder: 1, RequestFingerprint: fingerprint, RequestedOverrides: in.Overrides, ResolvedConfiguration: configuration, StartupResult: model.BotStartupResult{State: "pending"}, CreatedAt: now, UpdatedAt: now}
			want = cloneContractBot(want)
			candidate := cloneContractBot(want)
			candidate.Version, candidate.CreationOrder = 0, 0
			candidate.StartupResult = model.BotStartupResult{}
			candidate.CreatedAt, candidate.UpdatedAt = time.Time{}, time.Time{}
			dao := &creationContractDAO{t: t, ctx: t.Context(), principal: principal, steps: steps,
				candidate: candidate, result: cloneContractBot(want), defaults: contractBotDefaults(principal.UserID, worker, now)}
			got, err := Create(t.Context(), dao, principal, in, fingerprint, true)
			if err != nil || !reflect.DeepEqual(got, want) || len(dao.steps) != 0 {
				t.Fatalf("frozen creation: got=%#v want=%#v error=%v remaining=%v", got, want, err, dao.steps)
			}
		})
	}
}

func contractBotDefaults(owner, worker string, now time.Time) model.BotDefaultsInput {
	return model.BotDefaultsInput{
		ObservedAt: now,
		Workers: []model.WorkerSnapshot{{
			UserID: owner, WorkerID: worker, CreatedAt: now.Add(-time.Minute), LastReportedAt: now,
			Telemetry: model.WorkerTelemetry{
				Platform: model.PlatformLinux,
				AssistantHost: &model.WorkerAssistantHost{
					ProtocolVersion: 1, ObservedAt: now, DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot,
					Providers: []model.WorkerAssistantProvider{
						{Provider: model.AgentCodex, Available: true, Args: []string{}},
						{Provider: model.AgentClaude, Available: false, Reason: ptr("not_found"), Args: []string{}},
						{Provider: model.AgentCopilot, Available: true, Model: ptr("gpt-5"), Args: []string{"--effort", "high"}},
					},
				},
			},
		}},
		WorkerPreferences: map[string]model.BotWorkerPreference{},
	}
}
