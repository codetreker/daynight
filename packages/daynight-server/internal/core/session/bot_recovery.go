package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type BotRecoveryIdentity struct {
	BotRecoveryVersion int    `json:"botRecoveryVersion"`
	ServiceOrigin      string `json:"serviceOrigin"`
	RecoveryIdentity   string `json:"recoveryIdentity"`
}
type BotRecoveryBinding struct {
	SessionID       string  `json:"sessionId"`
	TestExecutionID string  `json:"testExecutionId"`
	NativeSessionID *string `json:"nativeSessionId"`
}
type BotRecoveryRegistration struct {
	BotRecoveryIdentity
	BotRecoveryBinding
	OperationID string `json:"operationId"`
	BotVersion  int64  `json:"botVersion,string"`
}
type BotRecoveryGrant struct {
	BotRecoveryIdentity
	BotRecoveryBinding
	OperationID               string   `json:"operationId"`
	ExpectedHostingGeneration int64    `json:"expectedHostingGeneration,string"`
	Grant                     sp.Grant `json:"grant"`
	ControllerToken           string   `json:"controllerToken"`
}
type BotRecoveryReport struct {
	BotRecoveryIdentity
	HostingGeneration int64     `json:"hostingGeneration,string"`
	Report            BotReport `json:"report"`
}

// BotRecoveryReceipt never contains the recovery secret or controller token.
// A client retains its token before submission; a receipt cannot renew it.
type BotRecoveryReceipt struct {
	BotRecoveryVersion int    `json:"botRecoveryVersion"`
	OperationID        string `json:"operationId"`
	Kind               string `json:"kind"`
	WorkerID           string `json:"workerId"`
	HostingGeneration  int64  `json:"hostingGeneration,string"`
	BotVersion         int64  `json:"botVersion,string"`
	BotRecoveryBinding
	ExecutionGeneration  string     `json:"executionGeneration"`
	ControllerID         string     `json:"controllerId"`
	ControllerInstanceID string     `json:"controllerInstanceId"`
	GrantExpiresAt       *time.Time `json:"grantExpiresAt"`
	ControllerTokenHash  *string    `json:"controllerTokenHash"`
}
type BotRecoveryResult struct {
	Receipt BotRecoveryReceipt `json:"receipt"`
	Current bool               `json:"current"`
}

func ValidateBotRecoveryIdentity(input BotRecoveryIdentity, origin string) ([]byte, error) {
	if input.BotRecoveryVersion != 1 {
		return nil, fault("upgrade_required", "Bot recovery version 1 is required.")
	}
	if origin == "" || input.ServiceOrigin != origin {
		return nil, denied()
	}
	value, err := base64.RawURLEncoding.DecodeString(input.RecoveryIdentity)
	if err != nil || len(value) != 32 || base64.RawURLEncoding.EncodeToString(value) != input.RecoveryIdentity {
		return nil, fault("invalid_input", "Invalid Bot recovery identity.")
	}
	hash := sha256.Sum256(value)
	return hash[:], nil
}

func (op *Operation) CheckBotRecoveryBinding(a *Access, input BotRecoveryBinding) error {
	v := a.record.Snapshot
	if input.SessionID != v.SessionID || input.TestExecutionID != v.TestExecutionID || !equalNative(input.NativeSessionID, v.Identity.NativeSessionID) {
		return conflict()
	}
	return nil
}

// GrantBotRecovery rotates the authorization and invalidates the old connection
// in the caller's Bot/Session transaction. Process-stop evidence remains the
// responsibility of the Worker; reconnecting preserves the native execution.
func (op *Operation) GrantBotRecovery(ctx context.Context, a *Access, p model.Principal, input BotRecoveryGrant) (GrantResult, error) {
	var empty GrantResult
	if err := op.CheckBotRecoveryBinding(a, input.BotRecoveryBinding); err != nil {
		return empty, err
	}
	const prefix = "dncontroller_"
	if len(input.ControllerToken) <= len(prefix) || input.ControllerToken[:len(prefix)] != prefix {
		return empty, fault("invalid_input", "Invalid recovery controller token.")
	}
	token, err := base64.RawURLEncoding.DecodeString(input.ControllerToken[len(prefix):])
	if err != nil || len(token) != 32 || base64.RawURLEncoding.EncodeToString(token) != input.ControllerToken[len(prefix):] {
		return empty, fault("invalid_input", "Invalid recovery controller token.")
	}
	if _, err = sp.DecodeBotGrant(encode(input.Grant)); err != nil {
		return empty, fault("invalid_input", "Invalid Bot recovery grant.")
	}
	if input.Grant.PreviousGeneration != nil && (input.NativeSessionID == nil || input.Grant.StopProof == nil || input.Grant.StopProof.Kind != "") {
		return empty, conflict()
	}
	hash := sha256.Sum256([]byte(input.ControllerToken))
	if bytes.Equal(hash[:], a.record.GrantHash) {
		return empty, conflict()
	}
	s := &Execution{Engine: op.engine}
	result, err := s.grantRecordWithToken(ctx, a.tx, p, a.record, task{}, input.Grant, input.ControllerToken)
	if err != nil {
		return empty, err
	}
	if err = a.tx.dao.DisconnectSession(ctx, a.record.Snapshot.SessionID); err != nil {
		return empty, err
	}
	a.record.ConnectionExpiry = nil
	a.record.GrantHash, a.record.GrantExpiry, a.record.Parent = hash[:], &result.ExpiresAt, p.CredentialID
	a.record.Snapshot.ConnectionState = "disconnected"
	a.record.Snapshot.Synchronized = false
	a.record.Snapshot.Operations = sp.Operations{}
	if err = s.emit(ctx, a.tx, a.record, "snapshot", a.record.Snapshot, nil); err != nil {
		return empty, err
	}
	if err = save(ctx, a.tx, a.record); err != nil {
		return empty, err
	}
	return result, nil
}

func (op *Operation) BotRecoveryReceipt(a *Access, bot model.Bot, operationID, kind string, grant *GrantResult) BotRecoveryReceipt {
	v := a.record.Snapshot
	r := BotRecoveryReceipt{BotRecoveryVersion: 1, OperationID: operationID, Kind: kind, WorkerID: bot.Recovery.WorkerID, HostingGeneration: bot.Recovery.HostingGeneration, BotVersion: bot.Version, BotRecoveryBinding: BotRecoveryBinding{SessionID: v.SessionID, TestExecutionID: v.TestExecutionID, NativeSessionID: v.Identity.NativeSessionID}, ExecutionGeneration: v.ExecutionGeneration, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID}
	if grant != nil {
		r.GrantExpiresAt = &grant.ExpiresAt
		hash := sha256.Sum256([]byte(grant.Token))
		value := hex.EncodeToString(hash[:])
		r.ControllerTokenHash = &value
	}
	return r
}

func (op *Operation) BotRecoveryCurrent(a *Access, bot model.Bot, r BotRecoveryReceipt, principal model.Principal) bool {
	if bot.Recovery == nil || bot.Deletion != nil || bot.Recovery.HostingGeneration != r.HostingGeneration || bot.Recovery.WorkerID != r.WorkerID {
		return false
	}
	if r.ControllerTokenHash == nil {
		return true
	}
	v := a.record
	return v.Parent == principal.CredentialID && r.GrantExpiresAt != nil && op.engine.now().Before(*r.GrantExpiresAt) && hex.EncodeToString(v.GrantHash) == *r.ControllerTokenHash && v.Snapshot.ExecutionGeneration == r.ExecutionGeneration && v.Snapshot.Identity.ControllerInstanceID == r.ControllerInstanceID
}

// NewBotExecution binds only Bot lifecycle operations to an independently
// authorized runtime runner; it does not expose ordinary Session access.
func NewBotExecution(engine *Engine, runner BotRunner) *Execution {
	return &Execution{Engine: engine, botRun: runner}
}
