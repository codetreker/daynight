package store

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// The source is part of migration 026's immutable checksum. Its legacy decoder
// owns the pre-row representation and does not consult the evolving registry.
//
//go:embed migration_property_rows.go
var propertyRowsTransformSource string

//go:embed migrations/026_task_property_rows.sql
var propertyRowsSQL string

type m026pullRequestDocument struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

type m026PullRequestProperty struct {
	URL   string
	Title string
}

func decodeLegacyPropertyRows026(raw []byte) (map[string]json.RawMessage, error) {
	fields, err := m026Object(raw, "properties", "pullRequests", "worker")
	if err != nil {
		return nil, err
	}
	prs, err := m026decodePullRequests(fields["pullRequests"])
	if err != nil {
		return nil, err
	}
	workerRaw, exists := fields["worker"]
	if !exists {
		return nil, fmt.Errorf("properties.worker is required")
	}
	worker, err := m026decodeWorker(workerRaw)
	if err != nil {
		return nil, err
	}
	documents := make([]m026pullRequestDocument, len(prs))
	for i, p := range prs {
		documents[i] = m026pullRequestDocument{URL: p.URL, Title: p.Title}
	}
	encoded, err := json.Marshal(documents)
	if err != nil {
		return nil, err
	}
	result := map[string]json.RawMessage{"pullRequests": encoded}
	if worker != nil {
		encoded, err = json.Marshal(m026encodeWorker(worker))
		if err != nil {
			return nil, err
		}
		result["worker"] = encoded
	}
	return result, nil
}

func migratePropertyRows026(ctx context.Context, tx pgx.Tx) error {
	var after *string
	for {
		rows, err := tx.Query(ctx, `SELECT id::text,properties FROM tasks WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 100`, after)
		if err != nil {
			return err
		}
		type row struct{ id, raw string }
		batch := make([]row, 0, 100)
		for rows.Next() {
			var item row
			if err := rows.Scan(&item.id, &item.raw); err != nil {
				rows.Close()
				return err
			}
			batch = append(batch, item)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(batch) == 0 {
			break
		}
		for _, item := range batch {
			values, err := decodeLegacyPropertyRows026([]byte(item.raw))
			if err != nil {
				return fmt.Errorf("migrate task %s properties: %w", item.id, err)
			}
			names := make([]string, 0, len(values))
			for name := range values {
				names = append(names, name)
			}
			slices.Sort(names)
			for _, name := range names {
				if _, err := tx.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)`, item.id, name, string(values[name])); err != nil {
					return err
				}
			}
		}
		id := batch[len(batch)-1].id
		after = &id
	}
	_, err := tx.Exec(ctx, `ALTER TABLE tasks DROP COLUMN properties`)
	return err
}

type m026WorkerState string

const (
	m026WorkerActive    m026WorkerState = "active"
	m026WorkerReleased  m026WorkerState = "released"
	m026WorkerCompleted m026WorkerState = "completed"
)

func (state m026WorkerState) Valid() bool {
	return state == m026WorkerActive || state == m026WorkerReleased || state == m026WorkerCompleted
}

type m026WorkerAgent string

const (
	m026AgentCodex   m026WorkerAgent = "codex"
	m026AgentClaude  m026WorkerAgent = "claude"
	m026AgentCopilot m026WorkerAgent = "copilot"
)

func (agent m026WorkerAgent) Valid() bool {
	return agent == m026AgentCodex || agent == m026AgentClaude || agent == m026AgentCopilot
}

type m026WorkerAgentControlMode string

const (
	m026AgentControlModeHerdr m026WorkerAgentControlMode = "herdr"
	m026AgentControlModeWeb   m026WorkerAgentControlMode = "web"
)

func (mode m026WorkerAgentControlMode) Supports(agent m026WorkerAgent) bool {
	return (mode == m026AgentControlModeHerdr || mode == m026AgentControlModeWeb) && agent.Valid()
}

type m026WorkerPhase string

const (
	m026WorkerPreparing  m026WorkerPhase = "preparing"
	m026WorkerExecuting  m026WorkerPhase = "executing"
	m026WorkerVerifying  m026WorkerPhase = "verifying"
	m026WorkerCompleting m026WorkerPhase = "completing"
	m026WorkerWaiting    m026WorkerPhase = "waiting"
	m026WorkerPaused     m026WorkerPhase = "paused"
)

func (phase m026WorkerPhase) Valid() bool {
	return phase == m026WorkerPreparing || phase == m026WorkerExecuting || phase == m026WorkerVerifying || phase == m026WorkerCompleting || phase == m026WorkerWaiting || phase == m026WorkerPaused
}

type m026WorkerMachine struct {
	ID   string
	Name string
}

type m026WorkerHerdr struct {
	Session     string
	WorkspaceID string
	PaneID      string
}

type m026WorkerClaim struct {
	ClaimID          string
	State            m026WorkerState
	UserID           string
	WorkerID         string
	Machine          m026WorkerMachine
	Platform         m026TaskPlatform
	Agent            m026WorkerAgent
	AgentControlMode m026WorkerAgentControlMode
	WorktreeID       string
	Phase            m026WorkerPhase
	Herdr            *m026WorkerHerdr
	NativeSessionID  *string
	ClaimedAt        time.Time
}

type m026TaskPlatform string

func (p m026TaskPlatform) Valid() bool { return p == "windows" || p == "linux" || p == "macos" }

type m026machineDocument struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type m026herdrDocument struct {
	Session     string `json:"session"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
}

type m026workerDocument struct {
	ClaimID          string                     `json:"claimId"`
	State            m026WorkerState            `json:"state"`
	UserID           string                     `json:"userId"`
	WorkerID         string                     `json:"workerId"`
	Machine          m026machineDocument        `json:"machine"`
	Platform         m026TaskPlatform           `json:"platform"`
	Agent            m026WorkerAgent            `json:"agent"`
	AgentControlMode m026WorkerAgentControlMode `json:"agentControlMode"`
	WorktreeID       string                     `json:"worktreeId"`
	Phase            m026WorkerPhase            `json:"phase"`
	Herdr            *m026herdrDocument         `json:"herdr"`
	NativeSessionID  *string                    `json:"nativeSessionId"`
	ClaimedAt        string                     `json:"claimedAt"`
}

func m026encodeWorker(worker *m026WorkerClaim) *m026workerDocument {
	if worker == nil {
		return nil
	}
	value := &m026workerDocument{ClaimID: worker.ClaimID, State: worker.State, UserID: worker.UserID, WorkerID: worker.WorkerID,
		Machine: m026machineDocument{ID: worker.Machine.ID, Name: worker.Machine.Name}, Platform: worker.Platform, Agent: worker.Agent, AgentControlMode: worker.AgentControlMode,
		WorktreeID: worker.WorktreeID, Phase: worker.Phase, NativeSessionID: worker.NativeSessionID, ClaimedAt: worker.ClaimedAt.UTC().Format(time.RFC3339Nano)}
	if worker.Herdr != nil {
		value.Herdr = &m026herdrDocument{Session: worker.Herdr.Session, WorkspaceID: worker.Herdr.WorkspaceID, PaneID: worker.Herdr.PaneID}
	}
	return value
}

func m026decodeWorker(data []byte) (*m026WorkerClaim, error) {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, nil
	}
	fields, err := m026Object(data, "properties.worker", "claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt")
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, 10)
	for _, key := range []string{"claimId", "state", "userId", "workerId", "platform", "agent", "worktreeId", "phase", "claimedAt"} {
		value, err := m026stringField(fields, key, "properties.worker")
		if err != nil {
			return nil, err
		}
		values[key] = value
	}
	for _, key := range []string{"claimId", "userId", "workerId", "worktreeId"} {
		if !m026validWorkerID(values[key]) {
			return nil, fmt.Errorf("properties.worker.%s must be a hyphenated UUID", key)
		}
	}
	machine, err := m026Object(fields["machine"], "properties.worker.machine", "id", "name")
	if err != nil {
		return nil, err
	}
	machineID, err := m026stringField(machine, "id", "properties.worker.machine")
	if err != nil {
		return nil, err
	}
	machineName, err := m026stringField(machine, "name", "properties.worker.machine")
	if err != nil {
		return nil, err
	}
	if !m026validWorkerID(machineID) || !m026validWorkerText(machineName) {
		return nil, fmt.Errorf("properties.worker.machine requires a UUID and nonempty UTF-8 name without NUL")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, values["claimedAt"])
	if err != nil || claimedAt.IsZero() {
		return nil, fmt.Errorf("properties.worker.claimedAt must be an RFC3339 timestamp")
	}
	worker := &m026WorkerClaim{ClaimID: values["claimId"], State: m026WorkerState(values["state"]), UserID: values["userId"], WorkerID: values["workerId"], Machine: m026WorkerMachine{ID: machineID, Name: machineName}, Platform: m026TaskPlatform(values["platform"]), Agent: m026WorkerAgent(values["agent"]), WorktreeID: values["worktreeId"], Phase: m026WorkerPhase(values["phase"]), ClaimedAt: claimedAt.UTC()}
	worker.AgentControlMode = m026AgentControlModeHerdr
	if _, exists := fields["agentControlMode"]; exists {
		mode, err := m026stringField(fields, "agentControlMode", "properties.worker")
		if err != nil {
			return nil, err
		}
		worker.AgentControlMode = m026WorkerAgentControlMode(mode)
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
		herdr, err := m026Object(fields["herdr"], "properties.worker.herdr", "session", "workspaceId", "paneId")
		if err != nil {
			return nil, err
		}
		parts := make([]string, 0, 3)
		for _, key := range []string{"session", "workspaceId", "paneId"} {
			value, err := m026stringField(herdr, key, "properties.worker.herdr")
			if err != nil {
				return nil, err
			}
			if !m026validWorkerText(value) {
				return nil, fmt.Errorf("properties.worker.herdr.%s must be nonempty UTF-8 text without NUL", key)
			}
			parts = append(parts, value)
		}
		worker.Herdr = &m026WorkerHerdr{Session: parts[0], WorkspaceID: parts[1], PaneID: parts[2]}
	}
	if worker.AgentControlMode == m026AgentControlModeWeb && worker.Herdr != nil {
		return nil, fmt.Errorf("properties.worker.herdr must be null for web execution")
	}
	raw, exists := fields["nativeSessionId"]
	if !exists {
		return nil, fmt.Errorf("properties.worker.nativeSessionId is required")
	}
	if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		var native string
		if json.Unmarshal(raw, &native) != nil || !m026validWorkerText(native) {
			return nil, fmt.Errorf("properties.worker.nativeSessionId must be null or nonempty UTF-8 text without NUL")
		}
		worker.NativeSessionID = &native
	}
	return worker, nil
}

func m026validWorkerID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return false
		}
	}
	return true
}

func m026validWorkerText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

func m026decodePullRequests(raw []byte) ([]m026PullRequestProperty, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("properties.pullRequests must be an array")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("properties.pullRequests must be an array")
	}
	values := make([]m026PullRequestProperty, 0, len(items))
	for index, item := range items {
		path := fmt.Sprintf("properties.pullRequests[%d]", index)
		fields, err := m026Object(item, path, "url", "title")
		if err != nil {
			return nil, err
		}
		url, err := m026stringField(fields, "url", path)
		if err != nil {
			return nil, err
		}
		title, err := m026stringField(fields, "title", path)
		if err != nil {
			return nil, err
		}
		values = append(values, m026PullRequestProperty{URL: url, Title: title})
	}
	return values, nil
}

func m026stringField(fields map[string]json.RawMessage, key, path string) (string, error) {
	raw, exists := fields[key]
	var value string
	if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s.%s is required and must be a string", path, key)
	}
	return value, nil
}

func m026Object(data []byte, path string, allowed ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("%s must be one JSON object", path)
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("%s must be valid JSON", path)
		}
		key, ok := token.(string)
		if !ok || !slices.Contains(allowed, key) {
			return nil, fmt.Errorf("%s contains an unknown or read-only field", path)
		}
		if _, exists := fields[key]; exists {
			return nil, fmt.Errorf("%s contains a duplicate field", path)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, fmt.Errorf("%s must be valid JSON", path)
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, fmt.Errorf("%s must be valid JSON", path)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("%s must contain exactly one JSON object", path)
	}
	return fields, nil
}
