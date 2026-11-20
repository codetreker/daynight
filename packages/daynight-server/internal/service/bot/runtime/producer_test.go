package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sc "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func producerPolicy(t *testing.T, p model.Principal, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestScopedRuntimeDeduplicatesSameParentPolicy(t *testing.T) {
	f := newRuntimeFixture(t, "begin", "write", "credential1", "botDAO", "bot", "authorize", "checkBot", "load", "credential2", "checkOwner", "authority", "credential3", "policy", "work", "credential4", "close")
	f.credentials = []model.Principal{f.principal, f.principal, f.principal, f.principal}
	s := f.runtime()
	s.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
		f.called("policy")
		if ctx != f.ctx || scope != f.scope || p != f.principal {
			t.Fatal("producer check changed the principal or transaction")
		}
		return producerPolicy(t, p, "session:produce"), nil
	}
	if err := s.Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(true)); err != nil {
		t.Fatal(err)
	}
}

// reportFixture keeps only the Session facts needed to exercise a live report;
// the Engine owns the actual connection and synchronization state.
type reportFixture struct {
	*recoveryFixture
	locks                []model.Principal
	revoked              model.Principal
	startup, preferences int
}

func (f *reportFixture) SessionDAO() store.SessionDAO { return f }
func (f *reportFixture) BotDAO() store.BotWriteDAO    { return f }
func (f *reportFixture) LockCredential(ctx context.Context, p model.Principal, _ time.Time) error {
	f.locks = append(f.locks, p)
	if p == f.revoked {
		return model.ErrNotFound
	}
	return nil
}
func (f *reportFixture) SaveSession(_ context.Context, r store.SessionRecord) error {
	f.record.Snapshot = r.Snapshot
	f.record.SourceEpoch, f.record.SourceEpochs, f.record.SourceSeq = r.SourceEpoch, r.SourceEpochs, r.SourceSeq
	return nil
}
func (f *reportFixture) ConnectSession(_ context.Context, _ string, instance string, now time.Time, expiry *time.Time) error {
	f.record.ServerInstance, f.record.LastSeen, f.record.ConnectionExpiry = &instance, &now, expiry
	f.record.ConnectionParent = f.record.Parent
	return nil
}
func (f *reportFixture) TouchSession(_ context.Context, _ string, now time.Time) error {
	f.record.LastSeen = &now
	return nil
}
func (f *reportFixture) UnreconciledSessionOperationCount(context.Context, string, int64) (int, error) {
	return 0, nil
}
func (f *reportFixture) SetBotStartup(ctx context.Context, id string, version int64, result model.BotStartupResult) (model.Bot, error) {
	f.startup++
	return f.recoveryFixture.SetBotStartup(ctx, id, version, result)
}
func (f *reportFixture) CommitBotPreferences(context.Context, string) error {
	f.preferences++
	return nil
}

func TestScopedRecoveryReadyChecksBothParents(t *testing.T) {
	for _, variant := range []string{"grant denied", "connection denied", "grant revoked", "connection revoked", "both allowed", "same parent"} {
		t.Run(variant, func(t *testing.T) {
			base := newRecoveryFixture(t)
			f := &reportFixture{recoveryFixture: base}
			connection := model.Principal{Kind: model.PATCredential, UserID: f.p.UserID, CredentialID: uuid.NewString()}
			parent := model.Principal{Kind: model.PATCredential, UserID: f.p.UserID, CredentialID: uuid.NewString()}
			if variant == "same parent" {
				parent = connection
			}
			if variant == "grant revoked" {
				f.revoked = parent
			} else if variant == "connection revoked" {
				f.revoked = connection
			}
			f.record.Parent = connection.CredentialID
			f.record.Snapshot.InitialInputState = "not_required"
			expiry := time.Now().Add(time.Hour)
			f.record.GrantExpiry = &expiry
			engine := f.service.engine
			withAccess := func(ctx context.Context, work func(*sc.Access) error) error {
				op, err := engine.BeginOperation()
				if err != nil {
					return err
				}
				defer op.Close()
				a, err := op.Load(ctx, f, *f.bot.SessionID, &f.bot)
				if err == nil {
					err = work(a)
				}
				if err != nil {
					op.Finish(store.TransactionNotCommitted)
				} else {
					op.Finish(store.TransactionCommitted)
				}
				return err
			}
			execution := sc.NewExecution(engine, nil, func(ctx context.Context, _ sp.ControllerFence, work func(*sc.Access) error) error {
				return withAccess(ctx, work)
			}, nil, nil, nil, func(ctx context.Context, _ []byte, work func(*sc.Access) error) error { return withAccess(ctx, work) }, nil, nil, nil, nil)
			v := f.record.Snapshot
			hello := sp.ControllerMessage{ControllerFence: v.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, SchemaVersion: 1, ProjectionVersion: 1, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0"}
			connected, err := execution.Connect(t.Context(), "token", hello, uuid.NewString())
			if err != nil {
				t.Fatalf("connect: %v", err)
			}
			state := sp.State{NativeSessionID: v.Identity.NativeSessionID, InitialInputState: "not_required", Activity: "idle", Synchronized: true}
			if _, err = execution.Handle(t.Context(), sp.ControllerMessage{Type: "sync_state", ControllerFence: connected.ControllerFence, State: &state}); err != nil {
				t.Fatalf("sync: %v", err)
			}
			// A same-generation grant replaces the grant parent while the first
			// connection is still live.
			f.record.Parent = parent.CredentialID
			var checked []model.Principal
			f.service.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
				if ctx != t.Context() || scope != f {
					t.Fatal("policy not read in report transaction")
				}
				checked = append(checked, p)
				if variant == "grant denied" && p == parent || variant == "connection denied" && p == connection {
					return producerPolicy(t, p, "session:read"), nil
				}
				return producerPolicy(t, p, "session:produce"), nil
			}
			f.service.write = func(ctx context.Context, op *sc.Operation, work func(store.SessionScope) error) error {
				err := work(f)
				if err != nil {
					op.Finish(store.TransactionNotCommitted)
				} else {
					op.Finish(store.TransactionCommitted)
				}
				return err
			}
			input := sc.BotRecoveryReport{BotRecoveryIdentity: f.identity, HostingGeneration: 1, Report: sc.BotReport{BotVersion: f.bot.Version, Fence: &connected.ControllerFence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, NativeSessionID: v.Identity.NativeSessionID, Result: model.BotStartupResult{State: "ready"}}}
			_, err = f.service.ReportBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
			want := []model.Principal{connection}
			if variant == "connection revoked" {
				want = nil
			}
			if variant != "connection denied" && variant != "connection revoked" && variant != "grant revoked" && variant != "same parent" {
				want = append(want, parent)
			}
			if !reflect.DeepEqual(checked, want) {
				t.Fatalf("checked %v, want %v", checked, want)
			}
			if variant == "grant denied" || variant == "connection denied" || variant == "grant revoked" || variant == "connection revoked" {
				code := "insufficient_scope"
				if variant == "grant revoked" || variant == "connection revoked" {
					code = "unauthenticated"
				}
				requireRuntimeFault(t, err, code)
				if f.startup != 0 || f.preferences != 0 {
					t.Fatal("refusal wrote startup")
				}
			} else if err != nil || f.startup != 1 || f.preferences != 1 {
				t.Fatalf("ready failed: %v startup=%d preferences=%d", err, f.startup, f.preferences)
			}
		})
	}
}

func TestScopedRuntimeChecksOriginalParentAndWorkPrincipal(t *testing.T) {
	for _, denied := range []string{"parent", "actor", "none"} {
		t.Run(denied, func(t *testing.T) {
			want := []string{"begin", "write", "credential1", "botDAO", "bot", "authorize", "checkBot", "load", "credential2", "checkOwner", "authority", "credential3", "parentPolicy"}
			if denied != "parent" {
				want = append(want, "work", "credential4", "actorPolicy")
			}
			f := newRuntimeFixture(t, append(want, "close")...)
			parent := f.principal
			f.principal.CredentialID = "66666666-6666-4666-8666-666666666666"
			f.credentials = []model.Principal{f.principal, f.principal, parent}
			if denied != "parent" {
				f.credentials = append(f.credentials, f.principal)
			}
			s := f.runtime()
			s.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
				f.context(ctx)
				if scope != f.scope {
					t.Fatal("producer check escaped transaction")
				}
				name := "actor"
				if p == parent {
					name = "parent"
				} else if p != f.principal {
					t.Fatalf("wrong producer: %+v", p)
				}
				f.called(name + "Policy")
				if name == denied {
					return producerPolicy(t, p, "session:read"), nil
				}
				return producerPolicy(t, p, "session:produce"), nil
			}
			err := s.Run(f.ctx, f.principal, f.workerID, f.id, nil, nil, f.work(true))
			if denied == "none" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				requireRuntimeFault(t, err, "insufficient_scope")
			}
		})
	}
}

func TestScopedRecoveryRejectsNewGrantButRetainsReceipt(t *testing.T) {
	f := newRecoveryFixture(t)
	f.executionError = &model.Fault{Code: "worker_disabled", Message: "Worker is disabled."}
	t.Cleanup(func() {
		if f.executionChecks != 0 {
			t.Fatal("scope rejection or receipt replay checked execution admission")
		}
	})
	input := f.input()
	checks := 0
	f.service.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
		checks++
		if ctx != t.Context() || scope != f || p != f.p {
			t.Fatal("recovery checked a different producer or transaction")
		}
		return producerPolicy(t, p, "session:read"), nil
	}
	_, err := f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
	requireRuntimeFault(t, err, "insufficient_scope")
	if checks != 1 || f.grant != nil || f.saved != nil || f.disconnected != 0 || f.advanced != 0 {
		t.Fatalf("refusal caused recovery side effects: checks=%d stages=%v", checks, f.stages)
	}
	receipt := sc.BotRecoveryReceipt{BotRecoveryVersion: 1, OperationID: input.OperationID, Kind: "takeover", WorkerID: f.bot.WorkerID, HostingGeneration: 1, BotRecoveryBinding: f.binding()}
	raw, _ := json.Marshal(receipt)
	f.prior = &store.BotRecoveryOperation{OperationID: input.OperationID, Kind: "takeover", RequestHash: requestHash(f.bot.WorkerID, "takeover", input), Receipt: raw}
	out, err := f.service.TakeoverBot(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
	if err != nil || !reflect.DeepEqual(out.Receipt, receipt) || checks != 1 || f.grant != nil {
		t.Fatalf("replay lost receipt or issued grant: %+v, %v, checks=%d", out, err, checks)
	}
}

func TestScopedRecoveryRegistrationAndGrant(t *testing.T) {
	for _, operation := range []string{"register", "grant"} {
		for _, allowed := range []bool{false, true} {
			t.Run(operation+map[bool]string{false: "/denied", true: "/allowed"}[allowed], func(t *testing.T) {
				f := newRecoveryFixture(t)
				calls := 0
				f.service.producer = func(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
					calls++
					if ctx != t.Context() || scope != f || p != f.p {
						t.Fatal("recovery changed the current producer or transaction")
					}
					if allowed {
						return producerPolicy(t, p, "session:produce"), nil
					}
					return producerPolicy(t, p, "session:read"), nil
				}
				var err error
				if operation == "register" {
					f.bot.Recovery = nil
					input := sc.BotRecoveryRegistration{BotRecoveryIdentity: f.identity, BotRecoveryBinding: f.binding(), OperationID: f.input().OperationID, BotVersion: f.bot.Version}
					_, err = f.service.RegisterBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, input)
				} else {
					_, err = f.service.GrantBotRecovery(t.Context(), f.p, f.bot.WorkerID, f.bot.ID, f.input())
				}
				if calls != 1 {
					t.Fatalf("producer checks = %d", calls)
				}
				if !allowed {
					requireRuntimeFault(t, err, "insufficient_scope")
					if f.registered != 0 || f.grant != nil || f.saved != nil || f.disconnected != 0 {
						t.Fatalf("refusal caused a write: %v", f.stages)
					}
				} else if err != nil || f.saved == nil || operation == "register" && f.registered != 1 || operation == "grant" && f.grant == nil {
					t.Fatalf("authorized recovery failed: %v; stages %v", err, f.stages)
				}
			})
		}
	}
}

func TestProducerRequiresMatchingScopedPATAndPropagatesErrors(t *testing.T) {
	f := newRecoveryFixture(t)
	want := errors.New("current policy unavailable")
	if _, err := NewScopedRuntime(nil, nil, nil); err == nil {
		t.Fatal("runtime accepted missing source")
	}
	if _, err := NewScopedRecovery(nil, nil, nil); err == nil {
		t.Fatal("recovery accepted missing source")
	}
	for _, tc := range []struct {
		name string
		auth model.CredentialAuthorization
		err  error
	}{
		{"missing policy", model.CredentialAuthorization{Principal: f.p, Profile: model.ScopedPATProfile}, nil},
		{"wrong identity", producerPolicy(t, model.Principal{Kind: model.PATCredential, UserID: f.p.UserID, CredentialID: "22222222-2222-4222-8222-222222222222"}, "session:produce"), nil},
		{"fixed profile", model.CredentialAuthorization{Principal: f.p, Profile: model.OAuthAPIProfile}, nil},
		{"source failure", model.CredentialAuthorization{}, want},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := requireProducer(t.Context(), f, f.p, func(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error) {
				return tc.auth, tc.err
			})
			if err == nil || tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("accepted invalid authorization or lost error: %v", err)
			}
		})
	}
}
