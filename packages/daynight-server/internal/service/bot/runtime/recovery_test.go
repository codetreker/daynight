package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sc "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type recoverySessionDAO interface{ store.SessionDAO }
type recoveryFixture struct {
	store.BotWriteDAO
	recoverySessionDAO
	t                                                      *testing.T
	p                                                      model.Principal
	bot                                                    model.Bot
	record                                                 store.SessionRecord
	identity                                               sc.BotRecoveryIdentity
	machine                                                model.WorkerMachine
	service                                                *Recovery
	prior                                                  *store.BotRecoveryOperation
	saved                                                  *store.BotRecoveryOperation
	grant                                                  *store.SessionGrant
	advanced, registered, disconnected, saves, credentials int
	stages                                                 []string
	failStage                                              string
	failure                                                error
	completion                                             store.TransactionOutcome
	transactionError                                       error
	tokenUsed                                              bool
}

func (f *recoveryFixture) BotDAO() store.BotWriteDAO    { return f }
func (f *recoveryFixture) SessionDAO() store.SessionDAO { return f }
func (f *recoveryFixture) BotRecoveryTokenUsed(ctx context.Context, id, hash string) (bool, error) {
	if id != f.bot.ID || len(hash) != 64 {
		f.t.Fatal("invalid token history query")
	}
	return f.tokenUsed, f.stage(ctx, "tokenHistory")
}
func (f *recoveryFixture) stage(ctx context.Context, name string) error {
	f.t.Helper()
	if ctx != f.t.Context() {
		f.t.Fatal("lost request context")
	}
	f.stages = append(f.stages, name)
	if name == f.failStage {
		return f.failure
	}
	return nil
}
func (f *recoveryFixture) LockCredential(ctx context.Context, p model.Principal, _ time.Time) error {
	f.credentials++
	if p != f.p {
		f.t.Fatal("recovery authenticated the old PAT instead of current principal")
	}
	return f.stage(ctx, "credential")
}
func (f *recoveryFixture) Bot(ctx context.Context, id string) (model.Bot, error) {
	if id != f.bot.ID {
		f.t.Fatal("changed Bot")
	}
	return f.bot, f.stage(ctx, "bot")
}
func (f *recoveryFixture) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	if id != *f.bot.SessionID {
		f.t.Fatal("changed Session")
	}
	return f.record, f.stage(ctx, "session")
}
func (f *recoveryFixture) RecoveryWorker(ctx context.Context, owner, worker string) (model.WorkerMachine, error) {
	if owner != f.p.UserID || worker == "" {
		f.t.Fatal("changed Worker owner")
	}
	return f.machine, f.stage(ctx, "worker")
}
func (f *recoveryFixture) BotRecoveryOperation(ctx context.Context, id, operation string) (store.BotRecoveryOperation, error) {
	if id != f.bot.ID {
		f.t.Fatal("changed operation owner")
	}
	if err := f.stage(ctx, "receipt"); err != nil {
		return store.BotRecoveryOperation{}, err
	}
	if f.prior == nil {
		return store.BotRecoveryOperation{}, model.ErrNotFound
	}
	return *f.prior, nil
}
func (f *recoveryFixture) SaveBotRecoveryOperation(ctx context.Context, id string, v store.BotRecoveryOperation) error {
	if id != f.bot.ID {
		f.t.Fatal("changed receipt owner")
	}
	f.saved = &v
	return f.stage(ctx, "saveReceipt")
}
func (f *recoveryFixture) RegisterBotRecovery(ctx context.Context, id string, version int64, recovery model.BotRecovery) (model.Bot, error) {
	f.registered++
	if id != f.bot.ID || version != f.bot.Version {
		f.t.Fatal("registration changed version")
	}
	bot := f.bot
	bot.Version++
	bot.Recovery = &recovery
	return bot, f.stage(ctx, "register")
}
func (f *recoveryFixture) AdvanceBotRecovery(ctx context.Context, id string, version, generation int64, worker string, machine model.WorkerMachine) (model.Bot, error) {
	f.advanced++
	if id != f.bot.ID || version != f.bot.Version || generation != f.bot.Recovery.HostingGeneration || machine != f.machine {
		f.t.Fatal("changed hosting preconditions")
	}
	bot := f.bot
	recovery := *bot.Recovery
	recovery.HostingGeneration++
	bot.Recovery = &recovery
	bot.Recovery.WorkerID = worker
	bot.Version++
	return bot, f.stage(ctx, "advance")
}
func (f *recoveryFixture) SetSessionGrant(ctx context.Context, grant store.SessionGrant) error {
	f.grant = &grant
	if grant.SessionID != *f.bot.SessionID || grant.ParentCredentialID != f.p.CredentialID {
		f.t.Fatal("grant used old Session or PAT")
	}
	return f.stage(ctx, "grant")
}
func (f *recoveryFixture) SaveSession(ctx context.Context, v store.SessionRecord) error {
	f.saves++
	if v.Snapshot.SessionID != *f.bot.SessionID || v.Snapshot.Identity.NativeSessionID == nil || *v.Snapshot.Identity.NativeSessionID != "original-native" {
		f.t.Fatal("lost native Session")
	}
	return f.stage(ctx, "saveSession")
}
func (f *recoveryFixture) RejectUnsentSessionOperations(ctx context.Context, id string, reason sp.OperationError) error {
	if id != *f.bot.SessionID || reason.Code != "permission_or_state_changed" {
		f.t.Fatalf("changed takeover refusal: %q %+v", id, reason)
	}
	return f.stage(ctx, "rejectUnsent")
}
func (f *recoveryFixture) DisconnectSession(ctx context.Context, id string) error {
	f.disconnected++
	if id != *f.bot.SessionID {
		f.t.Fatal("disconnected another Session")
	}
	return f.stage(ctx, "disconnect")
}

func newRecoveryFixture(t *testing.T) *recoveryFixture {
	t.Helper()
	f := &recoveryFixture{t: t, failure: errors.New("controlled recovery failure"), completion: store.TransactionCommitted}
	f.p = model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	session, execution, native := uuid.NewString(), uuid.NewString(), "original-native"
	secret := bytes.Repeat([]byte{7}, 32)
	hash := sha256.Sum256(secret)
	f.identity = sc.BotRecoveryIdentity{BotRecoveryVersion: 1, ServiceOrigin: "https://recovery.example", RecoveryIdentity: base64.RawURLEncoding.EncodeToString(secret)}
	f.machine = model.WorkerMachine{ID: "same-machine", Name: "Same machine"}
	f.bot = model.Bot{ID: uuid.NewString(), OwnerUserID: f.p.UserID, WorkerID: uuid.NewString(), Version: 3, SessionID: &session, TestExecutionID: &execution, RoleConfiguration: &model.BotRoleConfiguration{}, ResolvedConfiguration: model.BotConfiguration{Provider: "codex"}, Recovery: &model.BotRecovery{ServiceOrigin: f.identity.ServiceOrigin, IdentityHash: hash[:], MachineID: f.machine.ID, MachineName: f.machine.Name, HostingGeneration: 1}}
	f.bot.Recovery.WorkerID = f.bot.WorkerID
	f.record = store.SessionRecord{BotID: &f.bot.ID, Owner: f.p.UserID, Parent: uuid.NewString(), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: session, TestExecutionID: execution, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", Lifecycle: "active", Identity: sp.Identity{OwnerUserID: f.p.UserID, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), NativeSessionID: &native}}}
	engine := sc.NewEngine(nil)
	engine.Origin = f.identity.ServiceOrigin
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	f.service = NewRecovery(engine, func(ctx context.Context, op *sc.Operation, fn func(store.SessionScope) error) error {
		if err := fn(f); err != nil {
			op.Finish(store.TransactionNotCommitted)
			return err
		}
		op.Finish(f.completion)
		return f.transactionError
	})
	return f
}
func (f *recoveryFixture) binding() sc.BotRecoveryBinding {
	return sc.BotRecoveryBinding{SessionID: *f.bot.SessionID, TestExecutionID: *f.bot.TestExecutionID, NativeSessionID: f.record.Snapshot.Identity.NativeSessionID}
}
func (f *recoveryFixture) input() sc.BotRecoveryGrant {
	v := f.record.Snapshot
	return sc.BotRecoveryGrant{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), ExpectedHostingGeneration: 1, Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ExecutionGeneration: v.ExecutionGeneration, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Kind: "reconnect"}, ControllerToken: "dncontroller_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32))}
}

func TestRecoveryTakeoverCoordinatesOriginalSessionAndCurrentCredential(t *testing.T) {
	f := newRecoveryFixture(t)
	input := f.input()
	worker := uuid.NewString()
	out, err := f.service.TakeoverBot(t.Context(), f.p, worker, f.bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Current || out.Receipt.WorkerID != worker || out.Receipt.HostingGeneration != 2 || out.Receipt.ExecutionGeneration != "1" || out.Receipt.NativeSessionID == nil || *out.Receipt.NativeSessionID != "original-native" || f.credentials != 2 || f.advanced != 1 || f.disconnected != 1 || f.saves != 2 {
		t.Fatalf("incomplete takeover: %+v stages %v", out, f.stages)
	}
	want := []string{"credential", "bot", "session", "receipt", "worker", "tokenHistory", "grant", "saveSession", "rejectUnsent", "disconnect", "saveSession", "advance", "saveReceipt", "credential"}
	if !reflect.DeepEqual(f.stages, want) {
		t.Fatalf("transaction ordering: %v", f.stages)
	}
	if f.saved == nil || bytes.Contains(f.saved.Receipt, []byte(input.ControllerToken)) || bytes.Contains(f.saved.Receipt, []byte(input.RecoveryIdentity)) {
		t.Fatal("receipt leaked secret or was not written")
	}
}
func TestRecoveryRenewsOnlyTheCurrentExecution(t *testing.T) {
	for _, variant := range []string{"renew", "producer denied", "changed controller", "changed execution"} {
		t.Run(variant, func(t *testing.T) {
			f := newRecoveryFixture(t)
			expired := time.Now().Add(-time.Minute)
			f.record.GrantExpiry = &expired
			checks := 0
			f.service.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
				checks++
				if ctx != t.Context() || scope != f || p != f.p {
					t.Fatal("renewal changed producer authority")
				}
				if variant == "producer denied" {
					return producerPolicy(t, p, "session:read"), nil
				}
				return producerPolicy(t, p, "session:produce"), nil
			}
			input := f.input()
			if variant == "changed controller" {
				input.Grant.ControllerInstanceID = uuid.NewString()
			} else if variant == "changed execution" {
				input.Grant.ExecutionGeneration = "2"
			}
			out, err := f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
			if checks != 1 || f.advanced != 0 || f.registered != 0 {
				t.Fatalf("renewal changed admission or hosting: checks=%d advanced=%d registered=%d", checks, f.advanced, f.registered)
			}
			if variant == "renew" {
				if err != nil || !out.Current || f.grant == nil || !f.grant.ExpiresAt.After(time.Now()) || f.saved == nil || f.disconnected != 1 || f.credentials != 2 || out.Receipt.HostingGeneration != 1 || out.Receipt.ExecutionGeneration != "1" || out.Receipt.ControllerInstanceID != input.Grant.ControllerInstanceID {
					t.Fatalf("renewal lost current authority: out=%+v err=%v stages=%v", out, err, f.stages)
				}
			} else {
				code := "session_conflict"
				if variant == "producer denied" {
					code = "insufficient_scope"
				}
				requireRuntimeFault(t, err, code)
				if f.grant != nil || f.saved != nil || f.disconnected != 0 || f.saves != 0 {
					t.Fatalf("invalid renewal wrote state: %v", f.stages)
				}
			}
		})
	}
}

func TestRecoveryRegistrationUsesCurrentPATAndFreezesMachine(t *testing.T) {
	f := newRecoveryFixture(t)
	f.bot.Recovery = nil
	input := sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), BotVersion: f.bot.Version}
	out, err := f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
	if err != nil || !out.Current || out.Receipt.HostingGeneration != 1 || f.registered != 1 || f.grant != nil || f.credentials != 2 {
		t.Fatalf("registration: %+v %v stages %v", out, err, f.stages)
	}
}
func TestRecoveryReplayReturnsOriginalReceiptWithoutAnotherWrite(t *testing.T) {
	f := newRecoveryFixture(t)
	input := f.input()
	receipt := sc.BotRecoveryReceipt{BotRecoveryVersion: 1, OperationID: input.OperationID, Kind: "takeover", WorkerID: f.bot.WorkerID, HostingGeneration: 1, BotRecoveryBinding: f.binding()}
	raw, _ := json.Marshal(receipt)
	f.prior = &store.BotRecoveryOperation{OperationID: input.OperationID, Kind: "takeover", RequestHash: requestHash(f.bot.WorkerID, "takeover", input), Receipt: raw}
	out, err := f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
	if err != nil || !reflect.DeepEqual(out.Receipt, receipt) || f.grant != nil || f.advanced != 0 || f.saved != nil {
		t.Fatalf("replay mutated state: %+v %v", out, err)
	}
	input.ControllerToken += "x"
	if _, err = f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input); err == nil {
		t.Fatal("different original request accepted")
	}
}
func TestRecoveryOperationQueryDoesNotReissueGrant(t *testing.T) {
	f := newRecoveryFixture(t)
	receipt := sc.BotRecoveryReceipt{BotRecoveryVersion: 1, OperationID: uuid.NewString(), Kind: "takeover", WorkerID: uuid.NewString(), HostingGeneration: 2, BotRecoveryBinding: f.binding()}
	raw, _ := json.Marshal(receipt)
	f.prior = &store.BotRecoveryOperation{Receipt: raw}
	out, err := f.service.BotRecoveryOperation(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, receipt.OperationID, f.identity)
	if err != nil || out.Current || !reflect.DeepEqual(out.Receipt, receipt) || f.grant != nil || f.saved != nil {
		t.Fatalf("historical receipt query: %+v %v", out, err)
	}
}
func TestRecoveryFailuresStopSubsequentTransactionWork(t *testing.T) {
	for _, stage := range []string{"credential", "bot", "session", "receipt", "worker", "tokenHistory", "grant", "saveSession", "rejectUnsent", "disconnect", "advance", "saveReceipt"} {
		t.Run(stage, func(t *testing.T) {
			f := newRecoveryFixture(t)
			f.failStage = stage
			_, err := f.service.TakeoverBot(t.Context(), f.p, uuid.NewString(), f.bot.ID, f.input())
			if !errors.Is(err, f.failure) {
				t.Fatalf("lost cause: %v", err)
			}
			if f.stages[len(f.stages)-1] != stage {
				t.Fatalf("continued after failure: %v", f.stages)
			}
		})
	}
}
func TestRecoveryAuthorizationRejectsBeforeIssuingGrant(t *testing.T) {
	for _, kind := range []string{"owner", "origin", "secret", "generation", "machine", "deleted", "unregistered", "session", "native", "credential"} {
		t.Run(kind, func(t *testing.T) {
			f := newRecoveryFixture(t)
			in := f.input()
			switch kind {
			case "owner":
				f.bot.OwnerUserID = uuid.NewString()
			case "origin":
				in.ServiceOrigin = "https://other.example"
			case "secret":
				in.RecoveryIdentity = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
			case "generation":
				in.ExpectedHostingGeneration = 2
			case "machine":
				f.machine.ID = "other-machine"
			case "deleted":
				f.bot.Deletion = &model.BotDeletion{}
			case "unregistered":
				f.bot.Recovery = nil
			case "session":
				in.SessionID = uuid.NewString()
			case "native":
				in.NativeSessionID = nil
			case "credential":
				f.failStage = "credential"
				f.failure = model.ErrNotFound
			}
			if _, err := f.service.TakeoverBot(t.Context(), f.p, uuid.NewString(), f.bot.ID, in); err == nil || f.grant != nil {
				t.Fatalf("accepted %s: %v", kind, err)
			}
		})
	}
}
func TestRecoveryGrantAndReportRequireCurrentHosting(t *testing.T) {
	f := newRecoveryFixture(t)
	if _, err := f.service.GrantBotRecovery(t.Context(), f.p, uuid.NewString(), f.bot.ID, f.input()); err == nil || f.grant != nil {
		t.Fatal("grant admitted another Worker")
	}
	out, err := f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, f.input())
	if err != nil || out.Receipt.HostingGeneration != 1 || f.advanced != 0 {
		t.Fatalf("grant changed hosting: %+v %v", out, err)
	}
	code := "controlled_failure"
	report := sc.BotRecoveryReport{BotRecoveryIdentity: f.identity, HostingGeneration: 2, Report: sc.BotReport{BotVersion: f.bot.Version, Result: model.BotStartupResult{State: "failed", Code: &code}}}
	if _, err = f.service.ReportBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, report); err == nil {
		t.Fatal("stale hosting report admitted")
	}
}

func (f *recoveryFixture) SetBotStartup(ctx context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	if id != f.bot.ID || version != f.bot.Version {
		f.t.Fatal("startup changed Bot identity")
	}
	bot := f.bot
	bot.Version++
	bot.StartupResult = result
	return bot, f.stage(ctx, "startup")
}

func TestRecoveryCurrentHostingReportUsesOriginalFence(t *testing.T) {
	f := newRecoveryFixture(t)
	v := f.record.Snapshot
	code := "provider_unavailable"
	input := sc.BotRecoveryReport{BotRecoveryIdentity: f.identity, HostingGeneration: 1, Report: sc.BotReport{BotVersion: f.bot.Version, Fence: &v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, NativeSessionID: v.Identity.NativeSessionID, Result: model.BotStartupResult{State: "failed", Code: &code}}}
	out, err := f.service.ReportBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
	if err != nil || out.StartupResult.Code == nil || *out.StartupResult.Code != code || f.credentials != 2 {
		t.Fatalf("report: %+v %v %v", out, err, f.stages)
	}
	input.Report.BotVersion--
	if _, err = f.service.ReportBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input); err == nil {
		t.Fatal("stale report version accepted")
	}
}

func TestRecoveryRegistrationPreservesFailuresAndOriginalReceipt(t *testing.T) {
	for _, stage := range []string{"worker", "register", "saveReceipt"} {
		t.Run(stage, func(t *testing.T) {
			f := newRecoveryFixture(t)
			f.bot.Recovery = nil
			f.failStage = stage
			input := sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), BotVersion: f.bot.Version}
			if _, err := f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input); !errors.Is(err, f.failure) {
				t.Fatalf("lost %s error: %v", stage, err)
			}
		})
	}
	f := newRecoveryFixture(t)
	input := sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), BotVersion: f.bot.Version}
	receipt := sc.BotRecoveryReceipt{BotRecoveryVersion: 1, OperationID: input.OperationID, Kind: "register", HostingGeneration: 1, WorkerID: f.bot.WorkerID, BotRecoveryBinding: f.binding()}
	raw, _ := json.Marshal(receipt)
	f.prior = &store.BotRecoveryOperation{Kind: "register", RequestHash: requestHash(f.bot.WorkerID, "register", input), Receipt: raw}
	if out, err := f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input); err != nil || !out.Current || f.registered != 0 {
		t.Fatalf("registration replay: %+v %v", out, err)
	}
	f.prior = nil
	if _, err := f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input); err == nil {
		t.Fatal("replaced registered identity")
	}
}

func TestRecoveryRegistrationRejectsInconsistentInputs(t *testing.T) {
	for _, kind := range []string{"version", "binding", "machine", "unbound", "worker"} {
		t.Run(kind, func(t *testing.T) {
			f := newRecoveryFixture(t)
			f.bot.Recovery = nil
			worker := f.bot.WorkerID
			input := sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: uuid.NewString(), BotVersion: f.bot.Version}
			switch kind {
			case "version":
				input.BotVersion--
			case "binding":
				input.SessionID = uuid.NewString()
			case "machine":
				f.machine.ID = ""
			case "unbound":
				f.bot.SessionID = nil
			case "worker":
				worker = uuid.NewString()
			}
			if _, err := f.service.RegisterBotRecovery(t.Context(), f.p, worker, f.bot.ID, input); err == nil || f.registered != 0 {
				t.Fatalf("registered %s: %v", kind, err)
			}
		})
	}
}

func TestRecoveryUnknownCommitPreservesOriginalOperation(t *testing.T) {
	f := newRecoveryFixture(t)
	input := f.input()
	f.completion = store.TransactionUnknown
	f.transactionError = &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Phase: "commit", Cause: f.failure}
	_, err := f.service.TakeoverBot(t.Context(), f.p, uuid.NewString(), f.bot.ID, input)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "outcome_unknown" || !errors.Is(err, f.failure) || f.saved == nil || f.saved.OperationID != input.OperationID || f.advanced != 1 {
		t.Fatalf("unknown write lost operation/outcome: %v", err)
	}
}

func TestRecoveryInvalidTargetsAndMissingQueriesDoNotWrite(t *testing.T) {
	f := newRecoveryFixture(t)
	input := f.input()
	input.OperationID = "bad"
	if _, err := f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input); err == nil {
		t.Fatal("bad operation accepted")
	}
	if _, err := f.service.BotRecoveryOperation(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, "bad", f.identity); err == nil {
		t.Fatal("bad query accepted")
	}
	if _, err := f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, sc.BotRecoveryRegistration{}); err == nil {
		t.Fatal("empty registration accepted")
	}
	for _, kind := range []string{"worker", "bot", "principal"} {
		p, worker, id := f.p, f.bot.WorkerID, f.bot.ID
		switch kind {
		case "worker":
			worker = "bad"
		case "bot":
			id = "bad"
		case "principal":
			p.Kind = model.SessionCredential
		}
		if _, err := f.service.TakeoverBot(t.Context(), p, worker, id, f.input()); err == nil {
			t.Fatalf("invalid %s accepted", kind)
		}
	}
	if len(f.stages) != 0 {
		t.Fatalf("invalid target opened transaction: %v", f.stages)
	}
	if _, err := f.service.BotRecoveryOperation(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, uuid.NewString(), f.identity); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing receipt: %v", err)
	}
	f.prior = &store.BotRecoveryOperation{Receipt: json.RawMessage(`invalid`)}
	if _, err := f.service.BotRecoveryOperation(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, uuid.NewString(), f.identity); err == nil {
		t.Fatal("corrupt receipt accepted")
	}
}

func TestRecoveryCannotReinstateAnOlderControllerToken(t *testing.T) {
	f := newRecoveryFixture(t)
	f.tokenUsed = true
	if _, err := f.service.TakeoverBot(t.Context(), f.p, uuid.NewString(), f.bot.ID, f.input()); err == nil || f.grant != nil || f.advanced != 0 {
		t.Fatalf("historical token reused: %v", err)
	}
}

func TestRecoveryReceiptEncodingFailureDoesNotWritePartialOperation(t *testing.T) {
	f := newRecoveryFixture(t)
	invalidExpiry := time.Date(10000, time.January, 1, 0, 0, 0, 0, time.UTC)
	receipt := sc.BotRecoveryReceipt{OperationID: uuid.NewString(), Kind: "grant", GrantExpiresAt: &invalidExpiry}
	err := saveRecoveryOperation(t.Context(), f, f.bot.ID, receipt, []byte("original-request-hash"))
	var encodingError *json.MarshalerError
	if !errors.As(err, &encodingError) || f.saved != nil || len(f.stages) != 0 {
		t.Fatalf("invalid receipt was written or lost its encoding error: err=%v saved=%+v stages=%v", err, f.saved, f.stages)
	}
}

func TestRecoveryReportFailurePreservesStartupAndStopsFollowupWork(t *testing.T) {
	for _, failure := range []string{"startup", "version", "fence", "worker"} {
		t.Run(failure, func(t *testing.T) {
			f := newRecoveryFixture(t)
			v := f.record.Snapshot
			code := "provider_unavailable"
			input := sc.BotRecoveryReport{BotRecoveryIdentity: f.identity, HostingGeneration: 1, Report: sc.BotReport{BotVersion: f.bot.Version, Fence: &v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, NativeSessionID: v.Identity.NativeSessionID, Result: model.BotStartupResult{State: "failed", Code: &code}}}
			worker := f.bot.Recovery.WorkerID
			switch failure {
			case "startup":
				f.failStage = "startup"
			case "version":
				input.Report.BotVersion--
			case "fence":
				input.Report.Fence.ConnectionEpoch = "2"
			case "worker":
				worker = uuid.NewString()
			}
			out, err := f.service.ReportBotRecovery(t.Context(), f.p, worker, f.bot.ID, input)
			if err == nil || f.bot.StartupResult.State != "" || f.credentials != 1 || f.grant != nil || f.saved != nil || f.advanced != 0 {
				t.Fatalf("failed report changed startup or continued work: out=%+v err=%v stages=%v", out, err, f.stages)
			}
			if failure == "startup" {
				if !errors.Is(err, f.failure) || f.stages[len(f.stages)-1] != "startup" {
					t.Fatalf("startup persistence failure lost its cause or continued: err=%v stages=%v", err, f.stages)
				}
			} else {
				for _, stage := range f.stages {
					if stage == "startup" {
						t.Fatalf("rejected report wrote startup: %v", f.stages)
					}
				}
			}
		})
	}
}
