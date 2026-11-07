package task

import (
	"encoding/json"
	"reflect"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

type WorkerDescriptor struct {
	ClaimID          string
	WorkerID         string
	Machine          model.WorkerMachine
	Platform         model.TaskPlatform
	Agent            model.WorkerAgent
	AgentControlMode model.WorkerAgentControlMode
	WorktreeID       string
}
type ClaimWorker struct {
	WorkerDescriptor
	Version int64
}
type UpdateWorker struct {
	Version         int64
	ClaimID         string
	Phase           *model.WorkerPhase
	Herdr           **model.WorkerHerdr
	NativeSessionID **string
	StartupReport   *sp.StartupReport
}
type ReleaseWorker struct {
	Version          int64
	ClaimID          string
	StoppedConfirmed bool
}
type WithdrawWorker struct {
	Version int64
	ClaimID string
}
type ResumeWorker struct {
	ClaimWorker
	PreviousClaimID string
}

func CanonicalWorkerDescriptor(input WorkerDescriptor) (WorkerDescriptor, error) {
	if input.AgentControlMode == "" {
		input.AgentControlMode = model.AgentControlModeHerdr
	}
	for _, field := range []*string{&input.ClaimID, &input.WorkerID, &input.Machine.ID, &input.WorktreeID} {
		value, err := model.CanonicalID(*field)
		if err != nil {
			return WorkerDescriptor{}, err
		}
		*field = value
	}
	if !input.Platform.Valid() || !input.AgentControlMode.Supports(input.Agent) || !model.ValidWorkerText(input.Machine.Name) {
		return WorkerDescriptor{}, invalidInput("Worker requires a supported platform, agent/control mode combination and nonempty UTF-8 machine name without NUL.")
	}
	return input, nil
}

func WorkerReady(current model.Task) error {
	if !current.Status.IsExecutable() {
		return &model.Fault{Code: "invalid_transition", Message: "Only a ready todo task may be claimed."}
	}
	if len(current.BlockedBy) > 0 {
		return &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done or cancelled.", TaskIDs: current.BlockedBy}
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return err
	}
	if worker != nil && worker.State == model.WorkerActive {
		return ClaimConflict()
	}
	return nil
}

func ClaimAdmission(current model.Task, userID string, descriptor WorkerDescriptor) error {
	if err := WorkerReady(current); err != nil {
		return err
	}
	if current.AssignedTo == nil || *current.AssignedTo != userID {
		return &model.Fault{Code: "invalid_transition", Message: "Task must be assigned to the authenticated user for automatic execution."}
	}
	if !current.AllowAgents || !model.PlatformCompatible(current.RequiredPlatform, descriptor.Platform) {
		return &model.Fault{Code: "invalid_transition", Message: "Task does not permit automatic execution on this platform."}
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return err
	}
	return FreshWorkerExecution(worker, descriptor)
}

func ReleasedWorker(current model.Task, previousID string) (*model.WorkerClaim, error) {
	if err := WorkerReady(current); err != nil {
		return nil, err
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return nil, err
	}
	if worker == nil || worker.State != model.WorkerReleased || worker.ClaimID != previousID {
		return nil, ClaimConflict()
	}
	return worker, nil
}

func FreshWorkerExecution(worker *model.WorkerClaim, descriptor WorkerDescriptor) error {
	if worker == nil {
		return nil
	}
	if worker.ClaimID == descriptor.ClaimID {
		return &model.Fault{Code: "claim_conflict", Message: "A fresh claim ID is required for a new execution."}
	}
	if worker.WorktreeID == descriptor.WorktreeID {
		return &model.Fault{Code: "invalid_transition", Message: "A fresh worktree ID is required for a new execution."}
	}
	return nil
}

func AcquireWorker(current model.Task, userID string, descriptor WorkerDescriptor, claimedAt time.Time) (store.TaskWrite, error) {
	values := CurrentWrite(current)
	delete(values.Properties, "sessionStartup")
	values.Status = model.TaskInProgress
	var err error
	values.Properties, err = properties.WithWorker(values.Properties, &model.WorkerClaim{ClaimID: descriptor.ClaimID, State: model.WorkerActive, UserID: userID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode, WorktreeID: descriptor.WorktreeID, Phase: model.WorkerPreparing, ClaimedAt: claimedAt})
	return values, err
}

func ValidateWorkerUpdate(input UpdateWorker) (string, error) {
	claimID, err := model.CanonicalID(input.ClaimID)
	if err != nil {
		return "", err
	}
	if input.Phase == nil && input.Herdr == nil && input.NativeSessionID == nil && input.StartupReport == nil {
		return "", invalidInput("At least one worker execution field must be provided.")
	}
	if input.Phase != nil && !input.Phase.Valid() {
		return "", invalidInput("Worker phase is invalid.")
	}
	if input.Herdr != nil && *input.Herdr != nil {
		herdr := *input.Herdr
		if !model.ValidWorkerText(herdr.Session) || !model.ValidWorkerText(herdr.WorkspaceID) || !model.ValidWorkerText(herdr.PaneID) {
			return "", invalidInput("Herdr session, workspace and pane must be nonempty UTF-8 text without NUL.")
		}
	}
	if input.NativeSessionID != nil && *input.NativeSessionID != nil && !model.ValidWorkerText(**input.NativeSessionID) {
		return "", invalidInput("Native session ID must be null or nonempty UTF-8 text without NUL.")
	}
	if input.StartupReport != nil {
		raw, err := json.Marshal(input.StartupReport)
		if err != nil {
			return "", invalidInput("Invalid startup report.")
		}
		if _, err = sp.DecodeStartupReport(raw); err != nil {
			return "", invalidInput("Invalid startup report.")
		}
	}
	return claimID, nil
}

func WorkerUpdateAdmission(worker *model.WorkerClaim, userID, claimID string, input UpdateWorker) error {
	if worker.UserID != userID {
		return &model.Fault{Code: "forbidden", Message: "Only the current execution owner may update worker execution."}
	}
	if worker.AgentControlMode == model.AgentControlModeWeb && input.Herdr != nil && *input.Herdr != nil {
		return invalidInput("Web execution cannot bind Herdr resources.")
	}
	if input.StartupReport != nil && (worker.AgentControlMode != model.AgentControlModeWeb || input.StartupReport.ClaimID != claimID) {
		return ClaimConflict()
	}
	return nil
}

func WorkerUpdateCandidate(current model.Task, worker *model.WorkerClaim, claimID string, input UpdateWorker) (store.TaskWrite, bool, error) {
	reportChanged := false
	if input.StartupReport != nil {
		previous, err := taskproperty.SessionStartup(current.Properties)
		if err != nil {
			return store.TaskWrite{}, false, err
		}
		reportChanged = !reflect.DeepEqual(previous, input.StartupReport)
		if previous != nil && previous.ClaimID == claimID && previous.SessionID == input.StartupReport.SessionID && previous.ExecutionGeneration == input.StartupReport.ExecutionGeneration && previous.ControllerInstanceID == input.StartupReport.ControllerInstanceID {
			before, _ := strconv.ParseInt(previous.Revision, 10, 64)
			after, _ := strconv.ParseInt(input.StartupReport.Revision, 10, 64)
			if after < before || after == before && reportChanged {
				return store.TaskWrite{}, false, ClaimConflict()
			}
		}
	}
	next := *worker
	if input.Phase != nil {
		next.Phase = *input.Phase
	}
	if input.Herdr != nil {
		next.Herdr = *input.Herdr
	}
	if input.NativeSessionID != nil {
		next.NativeSessionID = *input.NativeSessionID
	}
	if !reportChanged && next.Phase == worker.Phase && model.EqualOptional(next.Herdr, worker.Herdr) && model.EqualOptional(next.NativeSessionID, worker.NativeSessionID) {
		return store.TaskWrite{}, false, nil
	}
	values := CurrentWrite(current)
	var err error
	values.Properties, err = properties.WithWorker(values.Properties, &next)
	if err != nil {
		return store.TaskWrite{}, false, err
	}
	if reportChanged {
		values.Properties["sessionStartup"], err = json.Marshal(input.StartupReport)
		if err != nil {
			return store.TaskWrite{}, false, err
		}
	}
	return values, true, nil
}

func WithdrawableWorker(current model.Task, claimID string) (*model.WorkerClaim, error) {
	if current.Status == model.TaskCancelled {
		return nil, cancelledTransition()
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return nil, err
	}
	if worker == nil || worker.ClaimID != claimID || (worker.State != model.WorkerActive && worker.State != model.WorkerReleased) {
		return nil, ClaimConflict()
	}
	return worker, nil
}

func ReleaseCandidate(current model.Task, worker *model.WorkerClaim) (store.TaskWrite, error) {
	next := *worker
	next.State = model.WorkerReleased
	values := CurrentWrite(current)
	values.Status = model.TaskTodo
	var err error
	values.Properties, err = properties.WithWorker(values.Properties, &next)
	return values, err
}

func WithdrawCandidate(current model.Task) (store.TaskWrite, error) {
	if current.Status == model.TaskCancelled {
		return store.TaskWrite{}, cancelledTransition()
	}
	values := CurrentWrite(current)
	values.Status, values.AllowAgents = model.TaskTodo, false
	var err error
	values.Properties, err = properties.WithWorker(values.Properties, nil)
	return values, err
}
