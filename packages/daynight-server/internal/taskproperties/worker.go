package taskproperties

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
	"github.com/google/uuid"
)

type machineDocument struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type herdrDocument struct {
	Session     string `json:"session"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
}

type workerDocument struct {
	ClaimID          string                      `json:"claimId"`
	State            core.WorkerState            `json:"state"`
	UserID           string                      `json:"userId"`
	WorkerID         string                      `json:"workerId"`
	Machine          machineDocument             `json:"machine"`
	Platform         core.TaskPlatform           `json:"platform"`
	Agent            core.WorkerAgent            `json:"agent"`
	AgentControlMode core.WorkerAgentControlMode `json:"agentControlMode"`
	WorktreeID       string                      `json:"worktreeId"`
	Phase            core.WorkerPhase            `json:"phase"`
	Signaling        string                      `json:"signaling"`
	Herdr            *herdrDocument              `json:"herdr"`
	NativeSessionID  *string                     `json:"nativeSessionId"`
	ClaimedAt        string                      `json:"claimedAt"`
}

func encodeWorker(worker *core.WorkerClaim) *workerDocument {
	if worker == nil {
		return nil
	}
	value := &workerDocument{ClaimID: worker.ClaimID, State: worker.State, UserID: worker.UserID, WorkerID: worker.WorkerID,
		Machine: machineDocument{ID: worker.Machine.ID, Name: worker.Machine.Name}, Platform: worker.Platform, Agent: worker.Agent, AgentControlMode: worker.AgentControlMode,
		WorktreeID: worker.WorktreeID, Phase: worker.Phase, Signaling: worker.Signaling, NativeSessionID: worker.NativeSessionID, ClaimedAt: worker.ClaimedAt.UTC().Format(time.RFC3339Nano)}
	if worker.Herdr != nil {
		value.Herdr = &herdrDocument{Session: worker.Herdr.Session, WorkspaceID: worker.Herdr.WorkspaceID, PaneID: worker.Herdr.PaneID}
	}
	return value
}

func decodeWorker(data []byte) (*core.WorkerClaim, error) {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, nil
	}
	fields, err := jsonobject.Decode(data, "properties.worker", "claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "signaling", "herdr", "nativeSessionId", "claimedAt")
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, 10)
	for _, key := range []string{"claimId", "state", "userId", "workerId", "platform", "agent", "worktreeId", "phase", "signaling", "claimedAt"} {
		value, err := stringField(fields, key, "properties.worker")
		if err != nil {
			return nil, err
		}
		values[key] = value
	}
	for _, key := range []string{"claimId", "userId", "workerId", "worktreeId"} {
		if !validWorkerID(values[key]) {
			return nil, fmt.Errorf("properties.worker.%s must be a hyphenated UUID", key)
		}
	}
	machine, err := jsonobject.Decode(fields["machine"], "properties.worker.machine", "id", "name")
	if err != nil {
		return nil, err
	}
	machineID, err := stringField(machine, "id", "properties.worker.machine")
	if err != nil {
		return nil, err
	}
	machineName, err := stringField(machine, "name", "properties.worker.machine")
	if err != nil {
		return nil, err
	}
	if !validWorkerID(machineID) || !validWorkerText(machineName) {
		return nil, fmt.Errorf("properties.worker.machine requires a UUID and nonempty UTF-8 name without NUL")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, values["claimedAt"])
	if err != nil || claimedAt.IsZero() {
		return nil, fmt.Errorf("properties.worker.claimedAt must be an RFC3339 timestamp")
	}
	worker := &core.WorkerClaim{ClaimID: values["claimId"], State: core.WorkerState(values["state"]), UserID: values["userId"], WorkerID: values["workerId"], Machine: core.WorkerMachine{ID: machineID, Name: machineName}, Platform: core.TaskPlatform(values["platform"]), Agent: core.WorkerAgent(values["agent"]), WorktreeID: values["worktreeId"], Phase: core.WorkerPhase(values["phase"]), Signaling: values["signaling"], ClaimedAt: claimedAt.UTC()}
	worker.AgentControlMode = core.AgentControlModeHerdr
	if _, exists := fields["agentControlMode"]; exists {
		mode, err := stringField(fields, "agentControlMode", "properties.worker")
		if err != nil {
			return nil, err
		}
		worker.AgentControlMode = core.WorkerAgentControlMode(mode)
	}
	if !worker.AgentControlMode.Supports(worker.Agent) {
		return nil, fmt.Errorf("properties.worker has an unsupported agent control mode and agent combination")
	}
	if !worker.State.Valid() || !worker.Platform.Valid() || !worker.Agent.Valid() || !worker.Phase.Valid() {
		return nil, fmt.Errorf("properties.worker has invalid state, platform, agent or phase")
	}
	if _, exists := fields["herdr"]; !exists {
		return nil, fmt.Errorf("properties.worker.herdr is required")
	}
	if !bytes.Equal(bytes.TrimSpace(fields["herdr"]), []byte("null")) {
		herdr, err := jsonobject.Decode(fields["herdr"], "properties.worker.herdr", "session", "workspaceId", "paneId")
		if err != nil {
			return nil, err
		}
		parts := make([]string, 0, 3)
		for _, key := range []string{"session", "workspaceId", "paneId"} {
			value, err := stringField(herdr, key, "properties.worker.herdr")
			if err != nil {
				return nil, err
			}
			if !validWorkerText(value) {
				return nil, fmt.Errorf("properties.worker.herdr.%s must be nonempty UTF-8 text without NUL", key)
			}
			parts = append(parts, value)
		}
		worker.Herdr = &core.WorkerHerdr{Session: parts[0], WorkspaceID: parts[1], PaneID: parts[2]}
	}
	if worker.AgentControlMode == core.AgentControlModeWeb && worker.Herdr != nil {
		return nil, fmt.Errorf("properties.worker.herdr must be null for web execution")
	}
	raw, exists := fields["nativeSessionId"]
	if !exists {
		return nil, fmt.Errorf("properties.worker.nativeSessionId is required")
	}
	if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var native string
		if json.Unmarshal(raw, &native) != nil || !validWorkerText(native) {
			return nil, fmt.Errorf("properties.worker.nativeSessionId must be null or nonempty UTF-8 text without NUL")
		}
		worker.NativeSessionID = &native
	}
	return worker, nil
}

func validWorkerID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	_, err := uuid.Parse(value)
	return err == nil
}

func validWorkerText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}
