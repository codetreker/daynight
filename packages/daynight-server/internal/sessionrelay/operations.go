package sessionrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

type operationRecord struct {
	Available bool
	Command   sp.Command
	Receipt   sp.Operation
	Actor     core.Principal
	Hash      []byte
	Epoch     *int64
	Seq       int64
	Deadline  time.Time
}

func loadOperation(ctx context.Context, tx pgx.Tx, session, id string) (operationRecord, error) {
	var o operationRecord
	var command, receipt []byte
	var kind string
	err := tx.QueryRow(ctx, `SELECT command,receipt,actor_user_id::text,credential_id::text,credential_kind,body_hash,dispatch_epoch,operation_seq,deadline FROM session_operations WHERE session_id=$1 AND operation_id=$2`, session, id).Scan(&command, &receipt, &o.Actor.UserID, &o.Actor.CredentialID, &kind, &o.Hash, &o.Epoch, &o.Seq, &o.Deadline)
	if err != nil {
		return o, err
	}
	o.Actor.Kind = core.CredentialKind(kind)
	if err = json.Unmarshal(command, &o.Command); err != nil {
		return o, err
	}
	err = json.Unmarshal(receipt, &o.Receipt)
	if rt, ok := tx.(*relayTx); ok {
		if live, e := rt.content(session, false); e != nil {
			return o, e
		} else if live != nil {
			if command, ok := live.Commands[id]; ok {
				o.Command = command
				o.Available = true
			}
		}
	}
	return o, err
}
func commandHash(c sp.Command) []byte {
	var payload any
	_ = json.Unmarshal(c.Payload, &payload)
	b := encode(sp.BindingFields(c.Fence, map[string]any{"sessionId": c.SessionID, "claimId": c.ClaimID, "executionGeneration": c.ExecutionGeneration, "operationId": c.OperationID, "kind": c.Kind, "payload": payload}))
	h := sha256.Sum256(b)
	return h[:]
}
func (s *Service) authorizeCommand(ctx context.Context, tx pgx.Tx, r *record, t task, c sp.Command) error {
	if !active(t, r) || c.Fence != r.Snapshot.Fence {
		return conflict()
	}
	permissionRecord := *r
	if r.FirstInputBlocked && r.Snapshot.TestExecutionID != "" && r.Snapshot.Identity.NativeSessionID == nil {
		var other bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND operation_id<>$2 AND command->>'kind'='send_message' AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted','confirmed','unknown'))`, r.Snapshot.SessionID, c.OperationID).Scan(&other)
		if err != nil {
			return err
		}
		permissionRecord.FirstInputBlocked = other
	}
	v := permissions(&permissionRecord, true, s.now())
	switch c.Kind {
	case "send_message":
		var p sp.SendMessage
		_ = json.Unmarshal(c.Payload, &p)
		if !v.Operations.CanSend {
			return conflict()
		}
		if v.Activity == "idle" && p.ExpectedTurnID != nil || v.Activity == "working" && (p.ExpectedTurnID == nil || v.CurrentTurnID == nil || *p.ExpectedTurnID != *v.CurrentTurnID) {
			return conflict()
		}
	case "cancel":
		var p sp.Cancel
		_ = json.Unmarshal(c.Payload, &p)
		if !v.Operations.CanCancel || v.CurrentTurnID == nil || p.ExpectedTurnID != *v.CurrentTurnID {
			return conflict()
		}
	case "update_setting", "execute_command", "refresh_controls":
		if v.Lifecycle != "active" || v.ConnectionState != "connected" || !v.Synchronized || !controlActivity(v.Activity) {
			return conflict()
		}
		if c.Kind == "refresh_controls" {
			if v.Controls != nil || v.TestExecutionID != "" && v.InitialInputState == "not_required" && v.Activity == "idle" {
				return nil
			}
			return conflict()
		}
		if v.InitialInputState != "provider_accepted" && v.InitialInputState != "confirmed" && v.InitialInputState != "not_required" {
			return conflict()
		}
		if v.Controls == nil {
			return conflict()
		}
		if c.Kind == "update_setting" {
			var p sp.UpdateSetting
			_ = json.Unmarshal(c.Payload, &p)
			if p.ExpectedControlsRevision != v.Controls.Revision {
				return conflict()
			}
			for _, setting := range v.Controls.Settings {
				if setting.ID != p.SettingID || !setting.Mutable {
					continue
				}
				for _, option := range setting.Options {
					if option.Value == p.Value {
						return nil
					}
				}
			}
		} else {
			var p sp.ExecuteCommand
			_ = json.Unmarshal(c.Payload, &p)
			if p.ExpectedControlsRevision != v.Controls.Revision || p.ExpectedTurnID != nil || v.Activity != "idle" || v.CurrentTurnID != nil {
				return conflict()
			}
			for _, command := range v.Controls.Commands {
				if command.ID == p.CommandID && command.Available && (command.ArgumentHint != nil || strings.TrimSpace(p.Arguments) == "") {
					return nil
				}
			}
		}
		return conflict()
	case "interaction_response":
		if !v.Operations.CanRespond {
			return conflict()
		}
		var p sp.InteractionResponse
		_ = json.Unmarshal(c.Payload, &p)
		if v.Lifecycle == "draining" && (r.DrainTimelineSeq == nil || !slices.Contains(v.CleanupInteractionIDs, p.InteractionID)) {
			return conflict()
		}
		var raw []byte
		if r.Live == nil {
			return conflict()
		}
		for _, entry := range r.Live.PendingInteractions {
			var interaction struct {
				ID       string `json:"interactionId"`
				Revision string `json:"revision"`
				State    string `json:"state"`
			}
			if json.Unmarshal(entry.Data["interaction"], &interaction) == nil && interaction.ID == p.InteractionID && interaction.Revision == p.InteractionRevision && interaction.State == "pending" && (r.DrainTimelineSeq == nil || number(entry.EntrySeq) > *r.DrainTimelineSeq) {
				raw = entry.Data["interaction"]
				break
			}
		}
		if raw == nil {
			return conflict()
		}
		if !responseMatches(raw, p.Response) {
			return conflict()
		}
		var duplicate bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND operation_id<>$2 AND command->>'kind'='interaction_response' AND command->'payload'->>'interactionId'=$3 AND receipt->>'state' NOT IN ('rejected','expired','failed'))`, v.SessionID, c.OperationID, p.InteractionID).Scan(&duplicate)
		if err != nil {
			return err
		}
		if duplicate {
			return conflict()
		}
	default:
		return fault("invalid_input", "Unsupported session operation.")
	}
	return nil
}
func responseMatches(raw, response []byte) bool {
	var i, r map[string]any
	if json.Unmarshal(raw, &i) != nil || json.Unmarshal(response, &r) != nil {
		return false
	}
	kind, _ := r["kind"].(string)
	if kind == "dismiss" {
		v, _ := i["canDismiss"].(bool)
		return v
	}
	if i["kind"] != kind {
		return false
	}
	if kind == "approval" {
		items, _ := i["actions"].([]any)
		for _, item := range items {
			if item == r["action"] {
				return true
			}
		}
		return false
	}
	if kind == "question" {
		questions, _ := i["questions"].([]any)
		answers, _ := r["answers"].([]any)
		found := map[string]bool{}
		for _, answer := range answers {
			a, ok := answer.(map[string]any)
			if !ok {
				return false
			}
			qid, _ := a["questionId"].(string)
			var q map[string]any
			for _, question := range questions {
				v, _ := question.(map[string]any)
				if v["questionId"] == qid {
					q = v
				}
			}
			if q == nil {
				return false
			}
			found[qid] = true
			opts, _ := a["optionIds"].([]any)
			multiple, _ := q["multiple"].(bool)
			if !multiple && len(opts) > 1 {
				return false
			}
			for _, o := range opts {
				valid := false
				allowed, _ := q["options"].([]any)
				for _, v := range allowed {
					opt, _ := v.(map[string]any)
					if opt["id"] == o {
						valid = true
					}
				}
				if !valid {
					return false
				}
			}
			custom, _ := q["allowCustom"].(bool)
			if a["text"] != nil && !custom {
				return false
			}
			required, _ := q["required"].(bool)
			text, _ := a["text"].(string)
			if required && len(opts) == 0 && text == "" {
				return false
			}
		}
		for _, qv := range questions {
			q, _ := qv.(map[string]any)
			req, _ := q["required"].(bool)
			id, _ := q["questionId"].(string)
			if req && !found[id] {
				return false
			}
		}
		return true
	}
	if kind == "form" {
		fields, _ := i["fields"].([]any)
		values, _ := r["values"].([]any)
		found := map[string]bool{}
		for _, v := range values {
			item, _ := v.(map[string]any)
			id, _ := item["fieldId"].(string)
			var field map[string]any
			for _, fv := range fields {
				f, _ := fv.(map[string]any)
				if f["fieldId"] == id {
					field = f
				}
			}
			if field == nil {
				return false
			}
			found[id] = true
			if !formMatches(field, item["value"]) {
				return false
			}
		}
		for _, fv := range fields {
			f, _ := fv.(map[string]any)
			required, _ := f["required"].(bool)
			id, _ := f["fieldId"].(string)
			if required && !found[id] {
				return false
			}
		}
		return true
	}
	return false
}
func formMatches(f map[string]any, v any) bool {
	switch f["type"] {
	case "text":
		s, ok := v.(string)
		return ok && (f["required"] != true || s != "")
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "number":
		n, ok := v.(float64)
		if !ok {
			return false
		}
		lo, lok := f["min"].(float64)
		hi, hok := f["max"].(float64)
		return (!lok || n >= lo) && (!hok || n <= hi)
	case "select", "multiselect":
		values := []any{v}
		if f["type"] == "multiselect" {
			var ok bool
			values, ok = v.([]any)
			if !ok {
				return false
			}
		}
		if f["required"] == true && len(values) == 0 {
			return false
		}
		for _, item := range values {
			valid := false
			opts, _ := f["options"].([]any)
			for _, ov := range opts {
				o, _ := ov.(map[string]any)
				if o["id"] == item {
					valid = true
				}
			}
			if !valid {
				return false
			}
		}
		return true
	}
	return false
}
func (s *Service) Submit(ctx context.Context, p core.Principal, project, taskID, id string, c sp.Command) (sp.Operation, error) {
	var result sp.Operation
	err := s.browser(ctx, p, project, taskID, id, func(tx pgx.Tx, r *record, t task, write bool) error {
		if !write {
			return denied()
		}
		if c.SessionID != id {
			return conflict()
		}
		old, err := loadOperation(ctx, tx, id, c.OperationID)
		hash := commandHash(c)
		if err == nil {
			if old.Actor.UserID != p.UserID {
				return denied()
			}
			if !bytes.Equal(old.Hash, hash) {
				return fault("operation_conflict", "Operation ID already has a different intent.")
			}
			result = old.Receipt
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if r.Live == nil || !r.Live.Synced {
			return fault("controller_offline", "Controller is not synchronized.")
		}
		if r.OperationSeq >= maxSessionOperations {
			return fault("rate_limited", "Session control ledger limit reached.")
		}
		if err = s.authorizeCommand(ctx, tx, r, t, c); err != nil {
			return err
		}
		var pending int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('accepted','offered','dispatching','provider_accepted')`, id).Scan(&pending); err != nil {
			return err
		}
		if pending >= 100 {
			return fault("rate_limited", "Session has 100 pending operations.")
		}
		result = sp.Operation{Fence: c.Fence, Protocol: sp.Protocol, OperationID: c.OperationID, Kind: c.Kind, State: "accepted"}
		r.OperationSeq++
		r.Live.Commands[c.OperationID] = c
		if _, err = tx.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, c.OperationID, r.OperationSeq, hash, encode(commandSummary(c)), p.UserID, p.CredentialID, string(p.Kind), encode(result)); err != nil {
			return err
		}
		if err = s.emit(ctx, tx, r, "operation", result, nil); err != nil {
			return err
		}
		return save(ctx, tx, r)
	})
	return result, err
}
func (s *Service) Operation(ctx context.Context, p core.Principal, project, taskID, id, operationID string) (sp.Operation, error) {
	var out sp.Operation
	err := s.browser(ctx, p, project, taskID, id, func(tx pgx.Tx, r *record, _ task, _ bool) error {
		o, e := loadOperation(ctx, tx, id, operationID)
		out = o.Receipt
		return e
	})
	return out, err
}
func (s *Service) operationAuthorized(ctx context.Context, tx pgx.Tx, r *record, t task, o operationRecord) error {
	admin, err := s.scopePermission(ctx, tx, o.Actor, r)
	if err != nil {
		return err
	}
	if !admin && o.Actor.UserID != r.Owner {
		return denied()
	}
	if !o.Available {
		return fault("controller_offline", "Operation body must be resent by its original caller.")
	}
	return s.authorizeCommand(ctx, tx, r, t, o.Command)
}
func (s *Service) updateReceipt(ctx context.Context, tx pgx.Tx, r *record, o sp.Operation) error {
	if _, err := tx.Exec(ctx, `UPDATE session_operations SET receipt=$3 WHERE session_id=$1 AND operation_id=$2`, o.SessionID, o.OperationID, encode(durableOperation(o))); err != nil {
		return err
	}
	if r.Live != nil && (terminal(o.State) || o.State == "unknown" || o.State == "provider_accepted") {
		delete(r.Live.Commands, o.OperationID)
	}
	return s.emit(ctx, tx, r, "operation", o, nil)
}
func (s *Service) Poll(ctx context.Context, f sp.ControllerFence) ([]map[string]any, error) {
	out := []map[string]any{}
	err := s.controller(ctx, f, func(tx pgx.Tx, r *record, t task) error {
		if r.LastSeen == nil || s.now().Sub(*r.LastSeen) > HeartbeatTimeout {
			return conflict()
		}
		out = append(out, s.contentRequests(tx, r)...)
		if (!active(t, r) && r.Snapshot.Lifecycle != "draining") || !r.Snapshot.Synchronized {
			return nil
		}
		rows, err := tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND receipt->>'state'='accepted' ORDER BY operation_seq LIMIT 100`, f.SessionID)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		total := 0
		for _, id := range ids {
			o, err := loadOperation(ctx, tx, f.SessionID, id)
			if err != nil {
				return err
			}
			if !s.now().Before(o.Deadline) {
				o.Receipt.State = "expired"
			} else if err = s.operationAuthorized(ctx, tx, r, t, o); err != nil {
				o.Receipt.State = "rejected"
				o.Receipt.Error = &sp.OperationError{Code: "permission_or_state_changed", Message: "Operation no longer has current permission or state."}
			} else {
				msg := envelope(r, "operation_offer")
				msg["operationSeq"] = decimal(o.Seq)
				msg["command"] = o.Command
				raw, err := sp.MarshalWire(msg)
				if err != nil {
					return err
				}
				size := len(raw)
				if size > sp.MaxFrameBytes {
					// A valid request can exceed the frame once wrapped as an offer.
					// Refuse that intent without withholding subsequent operations.
					o.Receipt.State = "rejected"
					o.Receipt.Error = &sp.OperationError{Code: "payload_too_large", Message: "Operation offer exceeds the 2 MiB session frame limit."}
				} else {
					if total+size > sp.MaxFrameBytes {
						break
					}
					total += size
					o.Receipt.State = "offered"
					out = append(out, msg)
					if _, err = tx.Exec(ctx, `UPDATE session_operations SET dispatch_epoch=$3 WHERE session_id=$1 AND operation_id=$2`, f.SessionID, id, number(f.ConnectionEpoch)); err != nil {
						return err
					}
				}
			}
			if err = s.updateReceipt(ctx, tx, r, o.Receipt); err != nil {
				return err
			}
		}
		if len(ids) == 0 {
			return nil
		}
		return save(ctx, tx, r)
	})
	return out, err
}
func (s *Service) begin(ctx context.Context, tx pgx.Tx, r *record, t task, id string) (map[string]any, error) {
	o, err := loadOperation(ctx, tx, r.Snapshot.SessionID, id)
	if err != nil {
		return nil, err
	}
	if o.Epoch == nil || *o.Epoch != number(r.Snapshot.ConnectionEpoch) || o.Receipt.State != "offered" && o.Receipt.State != "dispatching" {
		return nil, conflict()
	}
	if err = s.operationAuthorized(ctx, tx, r, t, o); err != nil {
		var refusal *service.Fault
		if o.Receipt.State != "offered" || !errors.As(err, &refusal) || (refusal.Code != "forbidden" && refusal.Code != "unauthenticated" && refusal.Code != "session_conflict") {
			return nil, err
		}
		// A stale offer has not crossed the native dispatch boundary. Reject only
		// that operation so unrelated work can continue on the same channel.
		o.Receipt.State = "rejected"
		o.Receipt.Error = &sp.OperationError{Code: "permission_or_state_changed", Message: "Operation no longer has current permission or state."}
		if err = s.updateReceipt(ctx, tx, r, o.Receipt); err != nil {
			return nil, err
		}
		out := envelope(r, "receipt_ack")
		out["operation"] = o.Receipt
		return out, nil
	}
	if o.Receipt.State == "offered" {
		o.Receipt.State = "dispatching"
		if err = s.updateReceipt(ctx, tx, r, o.Receipt); err != nil {
			return nil, err
		}
	}
	out := envelope(r, "operation_authorized")
	out["operationId"] = id
	return out, nil
}
func terminal(state string) bool {
	return state == "confirmed" || state == "failed" || state == "rejected" || state == "expired"
}
func (s *Service) receipt(ctx context.Context, tx pgx.Tx, r *record, receipt sp.Operation) (map[string]any, error) {
	o, err := loadOperation(ctx, tx, r.Snapshot.SessionID, receipt.OperationID)
	if err != nil {
		return nil, err
	}
	if receipt.Fence != r.Snapshot.Fence || receipt.Kind != o.Receipt.Kind || o.Epoch == nil || *o.Epoch != number(r.Snapshot.ConnectionEpoch) {
		return nil, conflict()
	}
	if !jsonEqual(encode(durableOperation(o.Receipt)), encode(durableOperation(receipt))) {
		if terminal(o.Receipt.State) || o.Receipt.State == "accepted" || (o.Receipt.State == "offered" && receipt.State != "rejected" && receipt.State != "expired") || receipt.State != "provider_accepted" && receipt.State != "confirmed" && receipt.State != "failed" && receipt.State != "unknown" && receipt.State != "rejected" && receipt.State != "expired" {
			return nil, conflict()
		}
		if (o.Receipt.State == "provider_accepted" && (receipt.State == "unknown" || receipt.State == "rejected" || receipt.State == "expired")) || (o.Receipt.State == "dispatching" && receipt.State == "expired") {
			return nil, conflict()
		}
		if err = s.updateReceipt(ctx, tx, r, receipt); err != nil {
			return nil, err
		}
	}
	out := envelope(r, "receipt_ack")
	out["operation"] = receipt
	return out, nil
}
func (s *Service) reconcile(ctx context.Context, tx pgx.Tx, r *record, t task, items []sp.Reconciliation, final bool) (map[string]any, error) {
	results := []sp.Operation{}
	for _, item := range items {
		o, err := loadOperation(ctx, tx, r.Snapshot.SessionID, item.OperationID)
		if err != nil {
			return nil, err
		}
		// An old execution's journal may settle history, but can never authorize a new call.
		if !terminal(o.Receipt.State) {
			state := item.State
			if o.Receipt.State == "provider_accepted" && (state == "not_submitted" || state == "dispatching" || state == "unknown" || state == "rejected" || state == "expired") {
				// An incomplete journal cannot erase a known native acceptance.
			} else if state == "not_submitted" {
				admin, authorization := s.scopePermission(ctx, tx, o.Actor, r)
				if authorization != nil {
					var refusal *service.Fault
					if !errors.As(authorization, &refusal) {
						return nil, authorization
					}
				}
				if o.Receipt.State == "offered" && o.Available && o.Command.ExecutionGeneration == r.Snapshot.ExecutionGeneration && active(t, r) && authorization == nil && (admin || o.Actor.UserID == r.Owner) {
					o.Receipt.State = "accepted"
				} else if o.Receipt.State == "offered" {
					o.Receipt.State = "rejected"
				} else if o.Receipt.State != "accepted" && o.Receipt.State != "provider_accepted" {
					o.Receipt.State = "unknown"
				}
			} else if state == "dispatching" || state == "expired" && (o.Receipt.State == "dispatching" || o.Receipt.State == "unknown") {
				o.Receipt.State = "unknown"
			} else {
				o.Receipt.State = state
				o.Receipt.ProviderResult = item.ProviderResult
				o.Receipt.Error = item.Error
			}
			if _, err = tx.Exec(ctx, `UPDATE session_operations SET dispatch_epoch=$3 WHERE session_id=$1 AND operation_id=$2`, r.Snapshot.SessionID, item.OperationID, number(r.Snapshot.ConnectionEpoch)); err != nil {
				return nil, err
			}
			if err = s.updateReceipt(ctx, tx, r, o.Receipt); err != nil {
				return nil, err
			}
		}
		results = append(results, o.Receipt)
	}
	if final {
		rows, err := tx.Query(ctx, `SELECT operation_id::text FROM session_operations WHERE session_id=$1 AND dispatch_epoch IS DISTINCT FROM $2 AND receipt->>'state' IN ('offered','dispatching') ORDER BY operation_seq LIMIT 100`, r.Snapshot.SessionID, number(r.Snapshot.ConnectionEpoch))
		if err != nil {
			return nil, err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			o, err := loadOperation(ctx, tx, r.Snapshot.SessionID, id)
			if err != nil {
				return nil, err
			}
			o.Receipt.State = "unknown"
			o.Receipt.Error = &sp.OperationError{Code: "journal_unavailable", Message: "The controller could not prove whether this operation was submitted."}
			if err = s.updateReceipt(ctx, tx, r, o.Receipt); err != nil {
				return nil, err
			}
			results = append(results, o.Receipt)
		}
	}
	out := envelope(r, "reconcile_result")
	out["operations"] = results
	return out, nil
}

// Only bounded targeting identifiers accompany the intent hash. User text,
// command arguments, approval answers and provider diagnostics stay on the host.
func commandSummary(c sp.Command) sp.Command {
	summary := c
	summary.RequestID = ""
	summary.Payload = json.RawMessage(`{}`)
	if c.Kind == "interaction_response" {
		var p sp.InteractionResponse
		_ = json.Unmarshal(c.Payload, &p)
		summary.Payload = encode(map[string]any{"interactionId": p.InteractionID})
	}
	return summary
}
