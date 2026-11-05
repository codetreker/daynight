package sessionrelay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) terminalState(ctx context.Context, tx pgx.Tx, r *terminalRecord, t task, write bool) (map[string]any, error) {
	if err := s.refreshTerminalControl(ctx, tx, r, t); err != nil {
		return nil, err
	}
	status, _, _, err := terminalArchive(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	control := r.Control
	if control != nil && (!write || !terminalActive(t, r) || !s.terminalOnline(r) || !r.Registration.Capabilities.Observe || !r.Registration.Capabilities.Control || !r.Registration.Capabilities.Archive || !terminalRecordingReady(r)) {
		copy := *control
		copy.AvailableActions = []string{}
		control = &copy
	}
	snapshot := s.terminalSnapshot(r)
	recording := []map[string]any{}
	for _, run := range r.Runs {
		rec := r.Recording[run.ExecutionGeneration]
		recording = append(recording, map[string]any{"executionGeneration": run.ExecutionGeneration, "responsibility": rec.Responsibility, "evidence": rec.Evidence})
	}
	return map[string]any{"status": "registered", "protocol": v2.Protocol, "schemaVersion": 2, "projectionVersion": 1, "sessionId": r.Envelope.SessionID, "claimId": r.Envelope.ClaimID, "executionGeneration": r.Envelope.ExecutionGeneration, "agentControlMode": "herdr", "contentKind": "terminal_recording", "owner": r.Owner, "binding": r.Binding, "connectionEpoch": r.ConnectionEpoch, "connected": s.terminalOnline(r) && terminalActive(t, r), "capabilities": r.Registration.Capabilities, "control": control, "snapshot": snapshot, "ledger": v2.GenerationLedger{Runs: r.Runs, FinalizationID: r.FinalizationID}, "archive": status, "recording": recording}, nil
}
func (s *Service) TerminalState(ctx context.Context, p model.Principal, project, taskID, id string) (map[string]any, error) {
	var out map[string]any
	err := s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, t task, write bool) error {
		var err error
		out, err = s.terminalState(ctx, tx, r, t, write)
		return err
	})
	return out, err
}

// TerminalArchiveState retains the original Worker's finalization readback after
// task deletion. It never grants browser access or advertises control actions.
func (s *Service) TerminalArchiveState(ctx context.Context, p model.Principal, project, taskID, id string) (map[string]any, error) {
	var out map[string]any
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		var err error
		out, err = s.terminalState(ctx, tx, r, t, false)
		return err
	})
	return out, err
}

func (s *Service) CurrentTerminal(ctx context.Context, p model.Principal, project, taskID string) (map[string]any, error) {
	var out map[string]any
	err := s.transact(ctx, func(tx pgx.Tx) error {
		t, err := lockTask(ctx, tx, project, taskID)
		if err != nil {
			return err
		}
		admin, err := member(ctx, tx, p, project, s.now())
		if err != nil {
			return err
		}
		if t.Worker == nil || t.Worker.AgentControlMode != model.AgentControlModeHerdr {
			out = map[string]any{"status": "not_applicable", "protocol": v2.Protocol}
			return nil
		}
		var id string
		err = tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND claim_id=$3 AND backend='herdr'`, project, taskID, t.Worker.ClaimID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			out = map[string]any{"status": "not_registered", "protocol": v2.Protocol, "claimId": t.Worker.ClaimID, "agentControlMode": "herdr"}
			return nil
		}
		if err != nil {
			return err
		}
		r, err := loadTerminal(ctx, tx, id)
		if err != nil {
			return err
		}
		out, err = s.terminalState(ctx, tx, r, t, admin || p.UserID == r.Owner.OwnerUserID)
		return err
	})
	return out, err
}

type terminalHistoryCursor struct{ Project, Task, Created, ID string }

func (s *Service) TerminalHistory(ctx context.Context, p model.Principal, project, taskID, token string, limit int) (map[string]any, error) {
	if limit < 1 || limit > 200 || len(token) > 1024 {
		return nil, fault("invalid_payload", "Invalid Session history page.")
	}
	var position terminalHistoryCursor
	var before *time.Time
	var beforeID *string
	if token != "" {
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || json.Unmarshal(raw, &position) != nil || position.Project != project || position.Task != taskID {
			return nil, fault("invalid_payload", "Invalid Session history cursor.")
		}
		at, err := time.Parse(time.RFC3339Nano, position.Created)
		if err != nil {
			return nil, fault("invalid_payload", "Invalid Session history timestamp.")
		}
		if _, err = uuid.Parse(position.ID); err != nil {
			return nil, fault("invalid_payload", "Invalid Session history identity.")
		}
		before = &at
		beforeID = &position.ID
	}
	var out map[string]any
	err := s.transact(ctx, func(tx pgx.Tx) error {
		if _, err := lockTask(ctx, tx, project, taskID); err != nil {
			return err
		}
		if _, err := member(ctx, tx, p, project, s.now()); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT s.id::text,s.claim_id::text,s.backend,s.created_at,s.snapshot,s.terminal_state,a.state,a.sha256,a.byte_length::text,a.completeness FROM task_sessions s LEFT JOIN session_archives a ON a.session_id=s.id WHERE s.project_id=$1 AND s.task_id=$2 AND s.scope='task' AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3,$4::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $5`, project, taskID, before, beforeID, limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		items := []map[string]any{}
		var nextCursor *string
		for rows.Next() {
			var id, claim, backend string
			var created time.Time
			var snapshot, terminal []byte
			var state, hash, size, completeness *string
			if err = rows.Scan(&id, &claim, &backend, &created, &snapshot, &terminal, &state, &hash, &size, &completeness); err != nil {
				return err
			}
			if len(items) == limit {
				last := items[len(items)-1]
				value := base64.RawURLEncoding.EncodeToString(encode(terminalHistoryCursor{Project: project, Task: taskID, Created: last["createdAt"].(string), ID: last["sessionId"].(string)}))
				nextCursor = &value
				break
			}
			content := "native_timeline"
			generation := ""
			var ended *string
			if backend == "herdr" {
				content = "terminal_recording"
				var r terminalRecord
				if err = json.Unmarshal(terminal, &r); err != nil {
					return err
				}
				generation = r.Envelope.ExecutionGeneration
				if len(r.Runs) > 0 {
					ended = r.Runs[len(r.Runs)-1].StoppedAt
				}
			}
			if backend == "web" {
				var v struct {
					ExecutionGeneration string `json:"executionGeneration"`
				}
				if err = json.Unmarshal(snapshot, &v); err != nil {
					return err
				}
				generation = v.ExecutionGeneration
			}
			archiveState := "unavailable"
			if backend == "herdr" {
				archiveState = "pending"
			}
			if state != nil {
				archiveState = *state
			}
			items = append(items, map[string]any{"sessionId": id, "claimId": claim, "executionGeneration": generation, "agentControlMode": backend, "contentKind": content, "createdAt": created.UTC().Format(time.RFC3339Nano), "endedAt": ended, "archive": map[string]any{"state": archiveState, "sha256": hash, "byteLength": size, "completeness": completeness}})
		}
		if err = rows.Err(); err != nil {
			return err
		}
		out = map[string]any{"items": items, "nextCursor": nextCursor}
		return nil
	})
	return out, err
}

// TerminalRecordingEvidence reconciles a known submitted body without replacing
// the current evidence checkpoint or exposing the Worker's journal contents.
func (s *Service) TerminalRecordingEvidence(ctx context.Context, p model.Principal, project, taskID, id, generation, evidenceID string) (map[string]any, error) {
	n := number(generation)
	parsed, err := uuid.Parse(evidenceID)
	if n < 1 || decimal(n) != generation || err != nil || parsed.String() != evidenceID {
		return nil, fault("invalid_payload", "Invalid recording evidence identity.")
	}
	var out map[string]any
	err = s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		var hash, revision string
		if err := tx.QueryRow(ctx, `SELECT body_hash,revision::text FROM session_recording_evidence WHERE session_id=$1 AND execution_generation=$2 AND evidence_id=$3`, id, n, evidenceID).Scan(&hash, &revision); err != nil {
			return err
		}
		out = map[string]any{"sessionId": id, "claimId": r.Envelope.ClaimID, "executionGeneration": generation, "evidenceId": evidenceID, "revision": revision, "bodyHash": hash}
		return nil
	})
	return out, err
}
