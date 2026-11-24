package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func recoveryAccess(t *testing.T, counts map[string]int) (fixture, *Operation, *Access, BotRecoveryGrant, context.Context) {
	t.Helper()
	f, out, _, _ := connectedBotFixture(t)
	native := "native-before-worker-replacement"
	f.data.Session.Snapshot.Identity.NativeSessionID = &native
	f.s.live[out.Session.SessionID].value.Snapshot.Identity.NativeSessionID = &native
	op, err := f.s.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(op.Close)
	counts["LockSession"] = 1
	ctx := botPhase(t, f, t.Context(), counts)
	a, err := op.Load(ctx, f.writer, out.Session.SessionID, &out.Bot)
	if err != nil {
		t.Fatal(err)
	}
	a.record.Snapshot.Synchronized = true
	a.record.Snapshot.Activity = "idle"
	a.record.Snapshot.Capabilities.Send = true
	a.record.Snapshot.Operations.CanSend = true
	a.record.Live.Snapshot = a.record.Snapshot
	v := a.record.Snapshot
	input := BotRecoveryGrant{
		BotRecoveryBinding: BotRecoveryBinding{SessionID: v.SessionID, TestExecutionID: v.TestExecutionID, NativeSessionID: &native},
		ControllerToken:    "dncontroller_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)),
		Grant:              sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"},
	}
	return f, op, a, input, ctx
}

func TestBotRecoveryIdentityRequiresExactOriginAndCanonicalSecret(t *testing.T) {
	secret := bytes.Repeat([]byte{23}, 32)
	valid := BotRecoveryIdentity{BotRecoveryVersion: 1, ServiceOrigin: "https://daynight.example", RecoveryIdentity: base64.RawURLEncoding.EncodeToString(secret)}
	hash, err := ValidateBotRecoveryIdentity(valid, valid.ServiceOrigin)
	want := sha256.Sum256(secret)
	if err != nil || !bytes.Equal(hash, want[:]) {
		t.Fatalf("identity hash = %x, %v", hash, err)
	}
	for _, tc := range []struct {
		name, origin, secret string
		version              int
		code                 string
	}{
		{"version", valid.ServiceOrigin, valid.RecoveryIdentity, 2, "upgrade_required"},
		{"unset origin", "", valid.RecoveryIdentity, 1, "forbidden"},
		{"other service", "https://other.example", valid.RecoveryIdentity, 1, "forbidden"},
		{"wrong length", valid.ServiceOrigin, "YWJj", 1, "invalid_input"},
		{"padding", valid.ServiceOrigin, valid.RecoveryIdentity + "=", 1, "invalid_input"},
		{"invalid alphabet", valid.ServiceOrigin, "!", 1, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := valid
			in.BotRecoveryVersion, in.RecoveryIdentity = tc.version, tc.secret
			hash, err := ValidateBotRecoveryIdentity(in, tc.origin)
			botFault(t, err, tc.code)
			if hash != nil {
				t.Fatal("refused identity returned a hash")
			}
		})
	}
}

func TestBotRecoveryGrantRejectsChangedIdentityAndUnsafeTokensBeforeWrites(t *testing.T) {
	for name, mutate := range map[string]func(*Access, *BotRecoveryGrant){
		"platform session":   func(_ *Access, in *BotRecoveryGrant) { in.SessionID = uuid.NewString() },
		"execution identity": func(_ *Access, in *BotRecoveryGrant) { in.TestExecutionID = uuid.NewString() },
		"missing native":     func(_ *Access, in *BotRecoveryGrant) { in.NativeSessionID = nil },
		"different native":   func(_ *Access, in *BotRecoveryGrant) { value := "replacement"; in.NativeSessionID = &value },
		"empty token":        func(_ *Access, in *BotRecoveryGrant) { in.ControllerToken = "" },
		"token prefix":       func(_ *Access, in *BotRecoveryGrant) { in.ControllerToken = "x" + in.ControllerToken },
		"token padding":      func(_ *Access, in *BotRecoveryGrant) { in.ControllerToken += "=" },
		"short token":        func(_ *Access, in *BotRecoveryGrant) { in.ControllerToken = "dncontroller_YWJj" },
		"reused token": func(a *Access, in *BotRecoveryGrant) {
			hash := sha256.Sum256([]byte(in.ControllerToken))
			a.record.GrantHash = hash[:]
		},
		"invalid grant": func(_ *Access, in *BotRecoveryGrant) { in.Grant.Kind = "other" },
		"unproved new process": func(_ *Access, in *BotRecoveryGrant) {
			in.Grant.ControllerInstanceID = uuid.NewString()
			in.Grant.ExecutionGeneration = "2"
		},
		"unknown native recovery": func(a *Access, in *BotRecoveryGrant) {
			a.record.Snapshot.Identity.NativeSessionID, in.NativeSessionID = nil, nil
			previous := "1"
			in.Grant.PreviousGeneration = &previous
			in.Grant.ExecutionGeneration, in.Grant.ControllerInstanceID = "2", uuid.NewString()
			in.Grant.StopProof = &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: a.record.Snapshot.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		},
	} {
		t.Run(name, func(t *testing.T) {
			f, op, a, input, ctx := recoveryAccess(t, map[string]int{})
			mutate(a, &input)
			result, err := op.GrantBotRecovery(ctx, a, f.p, input, false)
			if err == nil || result.Token != "" {
				t.Fatalf("unsafe recovery admitted: %+v, %v", result, err)
			}
		})
	}
}

func TestBotRecoveryGrantPreservesExecutionAndRevokesOldConnection(t *testing.T) {
	f, op, a, input, ctx := recoveryAccess(t, map[string]int{"SetSessionGrant": 1, "SaveSession": 2, "DisconnectSession": 1})
	before := fixtureCopy(a.record.Snapshot)
	if err := op.BindController(a, &TaskAccess{}, before.ControllerFence); err != nil {
		t.Fatalf("fixture lacks an authorized old connection: %v", err)
	}
	result, err := op.GrantBotRecovery(ctx, a, f.p, input, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Token != input.ControllerToken || result.SessionID != before.SessionID || result.TestExecutionID != before.TestExecutionID || result.ExecutionGeneration != before.ExecutionGeneration || result.ControllerInstanceID != before.Identity.ControllerInstanceID {
		t.Fatalf("reconnect changed execution: %+v", result)
	}
	if !reflect.DeepEqual(a.record.Snapshot.Identity, before.Identity) || a.record.ConnectionExpiry != nil || !f.writes.Disconnected {
		t.Fatal("recovery replaced identity or retained old connection lease")
	}
	if err := op.BindController(a, &TaskAccess{}, before.ControllerFence); err == nil {
		t.Fatal("old controller remained admitted after lease revocation")
	}
	for name, snapshot := range map[string]sp.Snapshot{"record": a.record.Snapshot, "live": a.record.Live.Snapshot, "proposed persistence": f.writes.Session.Snapshot} {
		if snapshot.ConnectionState != "disconnected" || snapshot.Synchronized || snapshot.Operations.CanSend {
			t.Fatalf("%s retained sending eligibility: %+v", name, snapshot)
		}
	}
	if permissions(a.record, true, f.s.now()).Operations.CanSend {
		t.Fatal("grant restored input before synchronization")
	}
	hash := sha256.Sum256([]byte(input.ControllerToken))
	if !bytes.Equal(f.writes.Grant.Hash, hash[:]) || f.writes.Grant.ParentCredentialID != f.p.CredentialID {
		t.Fatal("grant did not use retained token and current parent credential")
	}
}

func TestBotRecoveryNewProcessRequiresOriginalStopProof(t *testing.T) {
	f, op, a, input, ctx := recoveryAccess(t, map[string]int{"SetSessionGenerationStop": 1, "SetSessionGrant": 1, "SaveSession": 2, "DisconnectSession": 1})
	before := fixtureCopy(a.record.Snapshot)
	previous := before.ExecutionGeneration
	input.Grant.PreviousGeneration, input.Grant.ExecutionGeneration = &previous, "2"
	input.Grant.ControllerInstanceID = uuid.NewString()
	input.Grant.StopProof = &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: before.Identity.ControllerInstanceID, StoppedAt: f.s.now().UTC().Format(time.RFC3339Nano)}
	result, err := op.GrantBotRecovery(ctx, a, f.p, input, false)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExecutionGeneration != "2" || result.SessionID != before.SessionID || result.TestExecutionID != before.TestExecutionID || !equalNative(a.record.Snapshot.Identity.NativeSessionID, before.Identity.NativeSessionID) {
		t.Fatalf("process recovery replaced stable identity: %+v", result)
	}
	if !jsonEqual(f.writes.StopProof, encode(input.Grant.StopProof)) {
		t.Fatal("original stop proof was not proposed for persistence")
	}
}

func TestBotRecoveryGrantPreservesStorageFailures(t *testing.T) {
	for _, stage := range []string{"grant", "first save", "disconnect", "final save"} {
		t.Run(stage, func(t *testing.T) {
			counts := map[string]int{"SetSessionGrant": 1}
			if stage != "grant" {
				counts["SaveSession"] = 1
			}
			if stage == "disconnect" || stage == "final save" {
				counts["DisconnectSession"] = 1
			}
			if stage == "final save" {
				counts["SaveSession"] = 2
			}
			f, op, a, input, ctx := recoveryAccess(t, counts)
			failure := errors.New("controlled recovery storage failure")
			switch stage {
			case "grant":
				f.dao.SetSessionGrantFn = func(context.Context, store.SessionGrant) error { return failure }
			case "disconnect":
				f.dao.DisconnectSessionFn = func(context.Context, string) error { return failure }
			default:
				original, calls := f.dao.SaveSessionFn, 0
				f.dao.SaveSessionFn = func(ctx context.Context, record store.SessionRecord) error {
					calls++
					if stage == "first save" || calls == 2 {
						return failure
					}
					return original(ctx, record)
				}
			}
			result, err := op.GrantBotRecovery(ctx, a, f.p, input, false)
			if !errors.Is(err, failure) || result.Token != "" {
				t.Fatalf("storage failure lost: %+v, %v", result, err)
			}
		})
	}
}

func TestBotRecoveryReceiptSeparatesHistoricalSuccessFromCurrentGrant(t *testing.T) {
	f, op, a, input, ctx := recoveryAccess(t, map[string]int{"SetSessionGrant": 1, "SaveSession": 2, "DisconnectSession": 1})
	result, err := op.GrantBotRecovery(ctx, a, f.p, input, false)
	if err != nil {
		t.Fatal(err)
	}
	bot := botDAO(f).value
	bot.Recovery = &model.BotRecovery{HostingGeneration: 2, WorkerID: bot.WorkerID}
	operation := uuid.NewString()
	receipt := op.BotRecoveryReceipt(a, bot, operation, "takeover", &result)
	hash := sha256.Sum256([]byte(input.ControllerToken))
	if receipt.OperationID != operation || receipt.Kind != "takeover" || receipt.HostingGeneration != 2 || receipt.ControllerTokenHash == nil || *receipt.ControllerTokenHash != hex.EncodeToString(hash[:]) || receipt.GrantExpiresAt == nil || !receipt.GrantExpiresAt.Equal(result.ExpiresAt) || !op.BotRecoveryCurrent(a, bot, receipt, f.p) {
		t.Fatalf("receipt mismatched the original grant: %+v", receipt)
	}
	if bytes.Contains(encode(receipt), []byte(input.ControllerToken)) {
		t.Fatal("receipt exposed the controller secret")
	}
	otherCredential := f.p
	otherCredential.CredentialID = uuid.NewString()
	if op.BotRecoveryCurrent(a, bot, receipt, otherCredential) {
		t.Fatal("another PAT revived the original grant")
	}
	registered := op.BotRecoveryReceipt(a, bot, uuid.NewString(), "register", nil)
	if registered.ControllerTokenHash != nil || registered.GrantExpiresAt != nil || !op.BotRecoveryCurrent(a, bot, registered, f.p) {
		t.Fatal("registration receipt invented a grant")
	}
	for name, mutate := range map[string]func(*model.Bot, *BotRecoveryReceipt){
		"registration gone":   func(b *model.Bot, _ *BotRecoveryReceipt) { b.Recovery = nil },
		"deleted":             func(b *model.Bot, _ *BotRecoveryReceipt) { b.Deletion = &model.BotDeletion{} },
		"new host generation": func(b *model.Bot, _ *BotRecoveryReceipt) { b.Recovery.HostingGeneration++ },
		"new worker":          func(b *model.Bot, _ *BotRecoveryReceipt) { b.Recovery.WorkerID = uuid.NewString() },
		"missing expiry":      func(_ *model.Bot, r *BotRecoveryReceipt) { r.GrantExpiresAt = nil },
		"expired":             func(_ *model.Bot, r *BotRecoveryReceipt) { now := f.s.now().Add(-time.Second); r.GrantExpiresAt = &now },
		"replaced grant":      func(_ *model.Bot, r *BotRecoveryReceipt) { other := "other-token-hash"; r.ControllerTokenHash = &other },
		"new execution":       func(_ *model.Bot, r *BotRecoveryReceipt) { r.ExecutionGeneration = "3" },
		"new controller":      func(_ *model.Bot, r *BotRecoveryReceipt) { r.ControllerInstanceID = uuid.NewString() },
	} {
		t.Run(name, func(t *testing.T) {
			changedBot, changedReceipt := fixtureCopy(bot), fixtureCopy(receipt)
			mutate(&changedBot, &changedReceipt)
			if op.BotRecoveryCurrent(a, changedBot, changedReceipt, f.p) {
				t.Fatal("historical receipt restored replaced authority")
			}
		})
	}
}
