package migration115

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// These untagged fields retain the original inventory reader's encoding/json
// matching and timestamp decoding independently of later model changes.
type inventoryWorker struct {
	ClaimID, State, UserID, WorkerID                     string
	Machine                                              struct{ ID, Name string }
	Platform, Agent, AgentControlMode, WorktreeID, Phase string
	Herdr                                                *struct{ Session, WorkspaceID, PaneID string }
	NativeSessionID                                      *string
	ClaimedAt                                            time.Time
}

// validateWorker owns the stored codec at migration 115, including historical
// Herdr resources. New-claim admission and later field budgets do not apply.
func validateWorker(data []byte) error {
	fields, err := object(data, "worker", "claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt")
	if err != nil {
		return err
	}
	values := make(map[string]string, 10)
	for _, key := range []string{"claimId", "state", "userId", "workerId", "platform", "agent", "agentControlMode", "worktreeId", "phase", "claimedAt"} {
		value, err := stringField(fields, key, "worker")
		if err != nil {
			return err
		}
		values[key] = value
	}
	for _, key := range []string{"claimId", "userId", "workerId", "worktreeId"} {
		if !validID(values[key]) {
			return fmt.Errorf("worker.%s must be a hyphenated UUID", key)
		}
	}
	machine, err := object(fields["machine"], "worker.machine", "id", "name")
	if err != nil {
		return err
	}
	machineID, err := stringField(machine, "id", "worker.machine")
	if err != nil {
		return err
	}
	machineName, err := stringField(machine, "name", "worker.machine")
	if err != nil {
		return err
	}
	if !validID(machineID) || !validText(machineName) {
		return fmt.Errorf("worker.machine requires a UUID and nonempty UTF-8 name without NUL")
	}
	claimedAt, err := time.Parse(time.RFC3339Nano, values["claimedAt"])
	if err != nil || claimedAt.IsZero() {
		return fmt.Errorf("worker.claimedAt must be an RFC3339 timestamp")
	}
	for _, enum := range []struct {
		key     string
		allowed []string
	}{
		{"state", []string{"active", "completed"}},
		{"platform", []string{"windows", "linux", "macos"}},
		{"agent", []string{"codex", "claude", "copilot"}},
		{"agentControlMode", []string{"herdr", "web"}},
		{"phase", []string{"preparing", "executing", "verifying", "completing", "waiting", "paused"}},
	} {
		if !slices.Contains(enum.allowed, values[enum.key]) {
			return fmt.Errorf("worker.%s is unsupported", enum.key)
		}
	}
	herdrRaw, exists := fields["herdr"]
	if !exists && values["agentControlMode"] != "web" {
		return fmt.Errorf("worker.herdr is required")
	}
	if exists && !isNull(herdrRaw) {
		herdr, err := object(herdrRaw, "worker.herdr", "session", "workspaceId", "paneId")
		if err != nil {
			return err
		}
		for _, key := range []string{"session", "workspaceId", "paneId"} {
			value, err := stringField(herdr, key, "worker.herdr")
			if err != nil {
				return err
			}
			if !validText(value) {
				return fmt.Errorf("worker.herdr.%s must be nonempty UTF-8 text without NUL", key)
			}
		}
		if values["agentControlMode"] == "web" {
			return fmt.Errorf("worker.herdr must be null for web execution")
		}
	}
	nativeRaw, exists := fields["nativeSessionId"]
	if !exists {
		return fmt.Errorf("worker.nativeSessionId is required")
	}
	if !isNull(nativeRaw) {
		var native string
		if json.Unmarshal(nativeRaw, &native) != nil || !validText(native) {
			return fmt.Errorf("worker.nativeSessionId must be null or nonempty UTF-8 text without NUL")
		}
	}
	return nil
}

func validID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i := range len(value) {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if value[i] != '-' {
				return false
			}
		} else if !strings.ContainsRune("0123456789abcdefABCDEF", rune(value[i])) {
			return false
		}
	}
	return true
}

func validText(value string) bool {
	return strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}
