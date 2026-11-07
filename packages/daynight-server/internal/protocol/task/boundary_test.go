package task_test

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func TestMaximumTaskFieldsFitResponseBudgets(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	id := "d41a4e82-6bf0-4c7f-b519-47076dafc425"
	var prs json.RawMessage
	type pr struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	for length := 0; length <= taskproperty.MaxPullRequestTitleBytes; length++ {
		raw, err := json.Marshal([]pr{{URL: "<" + strings.Repeat("u", taskproperty.MaxPullRequestURLBytes-1), Title: strings.Repeat("t", taskproperty.MaxPullRequestTitleBytes)}, {URL: strings.Repeat("u", taskproperty.MaxPullRequestURLBytes), Title: strings.Repeat("t", length)}, {URL: strings.Repeat("u", taskproperty.MaxPullRequestURLBytes), Title: ""}})
		if err != nil {
			t.Fatal(err)
		}
		if len(raw) == taskproperty.MaxValueBytes {
			prs = raw
			break
		}
	}
	if len(prs) != taskproperty.MaxValueBytes {
		t.Fatal("fixture cannot reach property boundary")
	}
	native := strings.Repeat("<", taskproperty.MaxWorkerNativeSessionIDBytes)
	claim := &model.WorkerClaim{ClaimID: id, State: model.WorkerActive, UserID: id, WorkerID: id, Machine: model.WorkerMachine{ID: id, Name: strings.Repeat("<", taskproperty.MaxWorkerMachineNameBytes)}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: id, Phase: model.WorkerExecuting, Herdr: &model.WorkerHerdr{Session: strings.Repeat("<", taskproperty.MaxWorkerHerdrFieldBytes), WorkspaceID: strings.Repeat("<", taskproperty.MaxWorkerHerdrFieldBytes), PaneID: strings.Repeat("<", taskproperty.MaxWorkerHerdrFieldBytes)}, NativeSessionID: &native, ClaimedAt: now}
	rawWorker, err := taskproperty.EncodeWorker(claim)
	if err != nil {
		t.Fatal(err)
	}
	properties, err := taskproperty.Normalize(model.TaskProperties{"pullRequests": prs, "worker": rawWorker, "paused": json.RawMessage(`true`)})
	if err != nil {
		t.Fatal(err)
	}
	if err = taskproperty.Admit(properties); err != nil {
		t.Fatal(err)
	}
	title := strings.Repeat("<", text.MaxTitleBytes)
	description := strings.Repeat("<", text.MaxDescriptionBytes)
	if err = text.Admit(title, description); err != nil {
		t.Fatal(err)
	}
	deps := make([]string, taskcore.MaxDependencies)
	for i := range deps {
		deps[i] = fmt.Sprintf("%08x-0000-4000-8000-000000000001", i+1)
	}
	if err = taskcore.AdmitDependencies(deps); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: id, ProjectID: id, Title: title, Description: description, Properties: properties, Version: 9223372036854775807, CreatedAt: now, UpdatedAt: now, DependsOn: deps, ExternalDependsOn: deps, BlockedBy: deps}
	for _, extended := range []bool{false, true} {
		n, err := taskprotocol.EncodeREST(io.Discard, task, extended, taskcore.MaxTaskResponseJSONBytes)
		t.Logf("REST extended=%v bytes=%d", extended, n)
		if err != nil || n > taskcore.MaxTaskResponseJSONBytes {
			t.Fatalf("REST extended=%v size=%d error=%v", extended, n, err)
		}
	}
	n, err := taskprotocol.EncodeMCP(io.Discard, task, id, "changed", taskcore.MaxTaskResponseJSONBytes)
	if err != nil || n > taskcore.MaxTaskResponseJSONBytes {
		t.Fatalf("MCP size=%d error=%v", n, err)
	}
}

func TestMaximumProfileFieldsFitCompleteBudgets(t *testing.T) {
	name := strings.Repeat("n", identity.MaxProfileFieldBytes-1) + "<"
	email := strings.Repeat("e", identity.MaxProfileFieldBytes)
	avatar := strings.Repeat("a", identity.MaxAvatarURLBytes-1) + "<"
	team := "Personal"
	u := model.User{ID: "d41a4e82-6bf0-4c7f-b519-47076dafc425", UniAuthID: strings.Repeat("i", identity.MaxProfileFieldBytes), Name: &name, Email: &email, AvatarURL: &avatar, PersonalTeam: model.TeamRef{ID: "d41a4e82-6bf0-4c7f-b519-47076dafc425", Kind: "personal", Name: &team}}
	if err := identity.AdmitProfileFields(u); err != nil {
		t.Fatal(err)
	}
	n, err := profileprotocol.Encode(io.Discard, profileprotocol.FromUser(u), identity.MaxProfileJSONBytes)
	t.Logf("profile bytes=%d", n)
	if err != nil || n > identity.MaxProfileJSONBytes {
		t.Fatalf("profile size=%d error=%v", n, err)
	}
	n, err = profileprotocol.EncodeResponse(io.Discard, u, identity.MaxProfileJSONBytes)
	if err != nil || n > identity.MaxProfileJSONBytes {
		t.Fatalf("profile response size=%d error=%v", n, err)
	}
}

func TestMaximumWorkerFieldsFitCompleteBudgets(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	id := "d41a4e82-6bf0-4c7f-b519-47076dafc425"
	version := strings.Repeat("v", workercore.MaxVersionBytes-1) + "<"
	nativeModel := strings.Repeat("m", workercore.MaxNativeModelBytes-1) + "<"
	args := make([]string, workercore.MaxNativeArgs)
	for i := range args {
		args[i] = strings.Repeat("<", workercore.MaxNativeArgBytes)
	}
	host := &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: now, DefaultCwd: "/" + strings.Repeat("d", workercore.MaxWorkingDirectoryBytes-1), DefaultProvider: model.AgentCodex, Providers: []model.WorkerAssistantProvider{{Provider: model.AgentCodex, Available: true, Model: &nativeModel, Args: args}, {Provider: model.AgentCopilot, Available: true, Args: []string{}}, {Provider: model.AgentClaude, Available: true, Args: []string{}}}}
	os := model.WorkerOS{Type: strings.Repeat("t", workercore.MaxOSTypeBytes), Arch: strings.Repeat("a", workercore.MaxOSArchBytes), Release: strings.Repeat("r", workercore.MaxOSReleaseBytes), Version: strings.Repeat("v", workercore.MaxOSVersionBytes)}
	cpu := model.WorkerCPU{Model: strings.Repeat("c", workercore.MaxCPUModelBytes), LogicalProcessors: 1}
	memory := model.WorkerMemory{UsedBytes: 1, TotalBytes: 2}
	disk := model.WorkerDisk{AvailableBytes: 1, TotalBytes: 2}
	tele := model.WorkerTelemetry{Machine: model.WorkerMachine{ID: id, Name: strings.Repeat("m", workercore.MaxMachineNameBytes)}, Platform: model.PlatformLinux, WorkingDirectory: "/" + strings.Repeat("d", workercore.MaxWorkingDirectoryBytes-1), SampledAt: now, AssistantHost: host, OS: model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: now, Value: &os}, CPU: model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: &cpu}, Memory: model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: now, Value: &memory}, Disk: model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: now, Value: &disk}, Versions: model.WorkerVersions{Daynight: version, Herdr: model.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: &version}, Codex: model.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: &version}, Copilot: model.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: &version}}}
	claims := make([]model.WorkerTaskReference, workercore.MaxInventoryClaims)
	items := make([]model.WorkerObservedTask, len(claims))
	for i := range claims {
		tid := fmt.Sprintf("%08x-0000-4000-8000-000000000001", i+1)
		claims[i] = model.WorkerTaskReference{ProjectID: id, TaskID: tid, ClaimID: id}
		items[i] = model.WorkerObservedTask{ProjectID: id, TaskID: tid, ClaimID: id, Title: strings.Repeat("x", text.MaxTitleBytes-1) + "<", ProjectName: "Project", Status: model.TaskInProgress, Phase: model.WorkerExecuting, Agent: model.AgentCodex}
	}
	report := model.WorkerReport{Telemetry: tele, TaskInventory: &model.WorkerTaskInventory{ObservedAt: now, Claims: claims}}
	normalized, err := workercore.ValidateReport(report)
	if err != nil {
		t.Fatal(err)
	}
	if err = workercore.AdmitReport(normalized); err != nil {
		t.Fatal(err)
	}
	n, err := workerprotocol.EncodeTelemetry(io.Discard, normalized.Telemetry, workercore.MaxTelemetryJSONBytes)
	if err != nil || n > workercore.MaxTelemetryJSONBytes {
		t.Fatalf("telemetry size=%d error=%v", n, err)
	}
	snap := model.WorkerSnapshot{WorkerID: id, LastReportedAt: now, Telemetry: normalized.Telemetry, TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &now, InventoryObservedAt: &now, Items: items}}
	n, err = workerprotocol.EncodeItem(io.Discard, snap, workercore.MaxWorkerJSONBytes)
	t.Logf("worker item bytes=%d", n)
	if err != nil || n > workercore.MaxWorkerJSONBytes {
		t.Fatalf("worker size=%d error=%v", n, err)
	}
	n, err = workerprotocol.EncodeDetail(io.Discard, snap, now, workercore.MaxPageResponseJSONBytes)
	if err != nil || n > workercore.MaxPageResponseJSONBytes {
		t.Fatalf("worker response size=%d error=%v", n, err)
	}
	config := model.WorkerConfiguration{MaxConcurrent: workercore.MaxConcurrent, PollIntervalMs: workercore.MaxPollIntervalMs, RecoveryLimit: workercore.MaxRecoveryLimit, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Model: &nativeModel, Args: args}, Projects: []model.WorkerProjectConfiguration{}}
	config, err = workercore.NormalizeConfiguration(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = workercore.AdmitConfiguration(config); err != nil {
		t.Fatal(err)
	}
	n, err = workerprotocol.EncodeConfiguration(io.Discard, config, workercore.MaxConfigurationJSONBytes)
	if err != nil || n > workercore.MaxConfigurationJSONBytes {
		t.Fatalf("config size=%d error=%v", n, err)
	}
}
