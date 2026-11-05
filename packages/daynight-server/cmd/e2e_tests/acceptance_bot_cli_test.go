package e2e_tests

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

// Reports are controlled fixture inputs. This suite verifies the installed CLI
// and production HTTP/SQL contracts, not native Provider availability or execution.
func acceptanceBotHost(t *testing.T, process *acceptanceProcess, workerID, cwd string, assistant bool) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) map[string]any { return map[string]any{"state": "ok", "checkedAt": now, "value": value} }
	body := map[string]any{
		"machine": map[string]any{"id": uuid.NewString(), "name": "Controlled assistant host"}, "platform": "linux", "workingDirectory": cwd, "sampledAt": now,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "fixture", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "Fixture CPU", "logicalProcessors": 4, "usagePercent": 12.5}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "herdr": probe("0.9.5"), "codex": probe("fixture"), "copilot": map[string]any{"state": "not_installed", "checkedAt": now}},
		"taskInventory": map[string]any{"observedAt": now, "claims": []any{}},
	}
	if assistant {
		body["assistantHost"] = map[string]any{"protocolVersion": 1, "observedAt": now, "defaultCwd": cwd, "defaultProvider": "codex", "providers": []any{
			map[string]any{"provider": "codex", "available": true, "reason": nil, "model": nil, "args": []string{}},
			map[string]any{"provider": "claude", "available": false, "reason": "not_found", "model": nil, "args": []string{}},
			map[string]any{"provider": "copilot", "available": false, "reason": "not_found", "model": nil, "args": []string{}},
		}}
	}
	acceptanceDecode[api.WorkerReportResponse](t, process.request(context.Background(), http.MethodPost, "/api/v1/me/workers/"+workerID+"/report", body, ""), http.StatusOK)
}

func acceptanceBotCLIError(t *testing.T, cli *acceptanceCLI, code string, arguments ...string) {
	t.Helper()
	result := acceptanceCLIReceive(t, cli.start(t, cli.caller, arguments...))
	if result.status != 1 || result.stdout != "" {
		t.Fatalf("Bot CLI refusal lost its failure exit or wrote success output: %d", result.status)
	}
	value := acceptanceCLIJSON[struct {
		Error struct {
			Code               string `json:"code"`
			OutcomeUnconfirmed bool   `json:"outcomeUnconfirmed"`
		} `json:"error"`
	}](t, result.stderr)
	if value.Error.Code != code || value.Error.OutcomeUnconfirmed {
		t.Fatalf("Bot CLI did not preserve a definite %s refusal", code)
	}
}

func TestInstalledCLIAssistantDefaultsAndSystemFacts(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_assistant_defaults_and_system_facts", []string{"A1", "A2", "A6", "A7", "A9"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		legacy, supported := uuid.NewString(), uuid.NewString()
		acceptanceBotHost(t, process, legacy, cli.caller, false)
		acceptanceBotHost(t, process, supported, cli.caller, true)
		defaults := acceptanceDecode[api.BotDefaults](t, process.request(context.Background(), http.MethodGet, "/api/v1/me/bots/defaults", nil, ""), http.StatusOK)
		if defaults.WorkerID == nil || *defaults.WorkerID != supported || len(defaults.Workers) != 2 || defaults.Workers[0].WorkerID != legacy || defaults.Workers[0].State != "unsupported" {
			t.Fatal("assistant defaults selected an online legacy Worker without host support")
		}
		bot := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, "bot", "create", "--name", "日常助手", "--json"))
		if bot.ID == "" || bot.BotDefinition == nil || bot.Name != "日常助手" || bot.WorkerID != supported || bot.ResolvedConfiguration.Cwd != cli.caller || bot.ResolvedConfiguration.Provider != "codex" || bot.StartupResult.State != "pending" || bot.SessionID != nil || bot.RequestedOverrides.WorkerID != nil {
			t.Fatal("installed name-only creation did not freeze defaults without inventing execution")
		}
		replay := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, "bot", "create", "--name", "日常助手", "--request-id", bot.ID, "--json"))
		if !reflect.DeepEqual(bot, replay) {
			t.Fatal("installed creation replay changed the original Bot")
		}
		acceptanceBotCLIError(t, cli, "resource_conflict", "bot", "create", "--name", "changed", "--request-id", bot.ID, "--json")
		acceptanceBotCLIError(t, cli, "resource_conflict", "bot", "create", "--name", "Legacy", "--worker", legacy, "--json")
		acceptanceBotCLIError(t, cli, "resource_conflict", "bot", "create", "--name", "Unavailable", "--worker", supported, "--agent", "claude", "--json")
		bots := acceptanceCLIJSON[[]api.Bot](t, cli.run(t, cli.caller, "bot", "list", "--json"))
		if len(bots) != 1 || bots[0].ID != bot.ID {
			t.Fatal("rejected or repeated creates produced another Bot")
		}
		workers := acceptanceCLIJSON[struct {
			Items []api.WorkerSummary `json:"items"`
		}](t, cli.run(t, cli.caller, "worker", "list", "--json"))
		detail := acceptanceCLIJSON[api.WorkerDetailResponse](t, cli.run(t, cli.caller, "worker", "show", supported, "--json"))
		if len(workers.Items) != 2 || detail.Worker.WorkerID != supported || detail.Worker.Telemetry.AssistantHost == nil || detail.Worker.TaskObservationState != "observed" || detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 0 {
			t.Fatal("installed Worker queries lost host capability or observed inventory")
		}
		project := process.project(t, "Assistant system facts")
		prerequisite := process.task(t, project, "Prerequisite")
		target := process.task(t, project, "Dependent")
		cli.run(t, cli.caller, "task", "update", target.ID, "--project", project.ID, "--if-version", strconv.FormatInt(target.Version, 10), "--depends-on", prerequisite.ID)
		target = acceptanceCLIJSON[api.Task](t, cli.run(t, cli.caller, "task", "show", target.ID, "--project", project.ID, "--json"))
		cli.run(t, cli.caller, "task", "set-property", target.ID, "paused", "true", "--project", project.ID, "--if-version", strconv.FormatInt(target.Version, 10))
		target = acceptanceCLIJSON[api.Task](t, cli.run(t, cli.caller, "task", "show", target.ID, "--project", project.ID, "--json"))
		if target.Status != "todo" || target.Ready || string(target.Properties["paused"]) != "true" || !slices.Equal(target.DependsOn, []string{prerequisite.ID}) || !slices.Equal(target.BlockedBy, []string{prerequisite.ID}) {
			t.Fatal("installed system query conflated paused state, dependency blocking or readiness")
		}
		listed := acceptanceCLIJSON[[]api.Task](t, cli.run(t, cli.caller, "task", "list", "--project", project.ID, "--json"))
		if len(listed) != 2 {
			t.Fatal("installed task inventory lost the independent prerequisite")
		}
		if _, err := fixture.admin.Exec(context.Background(), "UPDATE workers SET last_seen_at=statement_timestamp()-interval '10 minutes' WHERE worker_id=$1", supported); err != nil {
			t.Fatal("cannot arrange isolated stale host observation")
		}
		acceptanceBotCLIError(t, cli, "resource_conflict", "bot", "create", "--name", "Offline", "--worker", supported, "--json")
		read := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, "bot", "show", bot.ID, "--json"))
		if !reflect.DeepEqual(read, bot) {
			t.Fatal("host becoming offline rewrote a frozen Bot definition")
		}
	})
}

func TestInstalledCLIAssistantDeletionIsolation(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_assistant_deletion_isolation", []string{"A5", "A6", "A9"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli := newAcceptanceCLI(t, receipt, scenario)
		cli.configure(t, process)
		worker := uuid.NewString()
		acceptanceBotHost(t, process, worker, cli.caller, true)
		sentinel := filepath.Join(cli.caller, "keep-user-data.txt")
		if err := os.WriteFile(sentinel, []byte("ordinary directory data"), 0o600); err != nil {
			t.Fatal("cannot prepare isolated ordinary-directory sentinel")
		}
		bot := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, "bot", "create", "--name", "Delete me", "--json"))
		other := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, "bot", "create", "--name", "Keep me", "--json"))
		project := process.project(t, "Independent work")
		task := process.task(t, project, "Keep this task")
		registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
		role := "Use the Daynight CLI."
		base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
		registered := acceptanceDecode[struct {
			Bot     api.Bot     `json:"bot"`
			Session sp.Snapshot `json:"session"`
		}](t, process.request(context.Background(), http.MethodPost, base+"/register", map[string]any{"botVersion": strconv.FormatInt(bot.Version, 10), "registration": registration, "configuration": bot.ResolvedConfiguration, "roleConfiguration": map[string]any{"instructions": role, "revision": "acceptance-v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(role)))}}, ""), http.StatusOK)
		bot = registered.Bot
		// This registered execution never receives a grant and never starts a writer.
		legacyRegistration := registration
		legacyRegistration.RegistrationID, legacyRegistration.TestExecutionID, legacyRegistration.ControllerID, legacyRegistration.ControllerInstanceID = uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
		type sessionResponse struct {
			Session sp.Snapshot `json:"session"`
		}
		legacy := acceptanceDecode[sessionResponse](t, process.request(context.Background(), http.MethodPost, "/api/v1/test-sessions", legacyRegistration, ""), http.StatusOK).Session
		if legacy.SessionID == "" {
			t.Fatal("independent Test registration returned no Session identity")
		}
		deletionID := uuid.NewString()
		args := []string{"bot", "delete", bot.ID, "--if-version", strconv.FormatInt(bot.Version, 10), "--request-id", deletionID, "--json"}
		acceptanceBotCLIError(t, cli, "version_conflict", "bot", "delete", bot.ID, "--if-version", "1", "--json")
		pending := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, args...))
		if pending.BotDefinition != nil || pending.Deletion == nil || pending.Deletion.DeletionID != deletionID || pending.Deletion.WorkerCleanup.State != "pending" || pending.Deletion.ServerCleanup.State != "pending" {
			t.Fatal("installed delete reported completion without Worker cleanup")
		}
		acceptanceError(t, process.request(context.Background(), http.MethodGet, "/api/v1/test-sessions/"+registered.Session.SessionID, nil, ""), http.StatusConflict, "resource_conflict")
		stop := sp.TestStop{Protocol: sp.Protocol, Fence: registered.Session.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
		completion := map[string]any{"deletionId": deletionID, "stop": stop, "result": map[string]any{"state": "completed", "code": nil}}
		acceptanceDecode[api.Bot](t, process.request(context.Background(), http.MethodPost, base+"/deletion-complete", completion, ""), http.StatusOK)
		completed := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, "bot", "show", bot.ID, "--json"))
		if completed.BotDefinition != nil || completed.Deletion == nil || completed.Deletion.WorkerCleanup.State != "completed" || completed.Deletion.ServerCleanup.State != "completed" {
			t.Fatal("installed show did not expose both confirmed cleanup phases")
		}
		replayed := acceptanceCLIJSON[api.Bot](t, cli.run(t, cli.caller, args...))
		if !reflect.DeepEqual(replayed, completed) {
			t.Fatal("exact delete replay changed its completed responsibility")
		}
		visible := acceptanceCLIJSON[[]api.Bot](t, cli.run(t, cli.caller, "bot", "list", "--json"))
		if len(visible) != 1 || !reflect.DeepEqual(visible[0], other) {
			t.Fatal("Bot deletion affected a different Bot or left the deleted one visible")
		}
		preserved := acceptanceCLIJSON[api.Task](t, cli.run(t, cli.caller, "task", "show", task.ID, "--project", project.ID, "--json"))
		if !reflect.DeepEqual(preserved, task) {
			t.Fatal("Bot deletion modified independent task data")
		}
		if data, err := os.ReadFile(sentinel); err != nil || string(data) != "ordinary directory data" {
			t.Fatal("Bot deletion changed ordinary working-directory data")
		}
		readLegacy := acceptanceDecode[sessionResponse](t, process.request(context.Background(), http.MethodGet, "/api/v1/test-sessions/"+legacy.SessionID, nil, ""), http.StatusOK).Session
		if readLegacy.SessionID != legacy.SessionID || readLegacy.TestExecutionID != legacy.TestExecutionID {
			t.Fatal("Bot deletion or registration migrated an independent Test Session")
		}
		var remaining int
		if err := fixture.admin.QueryRow(context.Background(), "SELECT count(*) FROM task_sessions WHERE bot_id=$1", bot.ID).Scan(&remaining); err != nil || remaining != 0 {
			t.Fatal("completed Bot deletion retained its Session history")
		}
	})
}
