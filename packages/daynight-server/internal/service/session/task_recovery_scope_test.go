package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type taskGrantDAO struct {
	*scopeTestDAO
	writes []string
}

func (d *taskGrantDAO) SetSessionGenerationStop(_ context.Context, _ string, _ []byte) error {
	d.writes = append(d.writes, "stop")
	return nil
}
func (d *taskGrantDAO) SetSessionGrant(_ context.Context, _ store.SessionGrant) error {
	d.writes = append(d.writes, "grant")
	return nil
}
func (d *taskGrantDAO) SaveSession(_ context.Context, _ store.SessionRecord) error {
	d.writes = append(d.writes, "save")
	return nil
}

type taskGrantScope struct{ dao *taskGrantDAO }

func (s taskGrantScope) SessionDAO() store.SessionDAO { return s.dao }
func (taskGrantScope) BotDAO() store.BotWriteDAO      { return nil }

type taskGrantWriter struct{ scope taskGrantScope }

func (w taskGrantWriter) WriteSession(_ context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	err := work(w.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func TestScopedTaskRecoveryGrantRetainsOwnerClaimAndFence(t *testing.T) {
	for _, tc := range []struct {
		name       string
		change     func(*sp.Grant, *store.SessionRecord)
		retry      bool
		wantWrites int
	}{
		{"valid", func(*sp.Grant, *store.SessionRecord) {}, true, 3},
		{"wrong claim", func(g *sp.Grant, _ *store.SessionRecord) { g.ClaimID = uuid.NewString() }, true, 0},
		{"wrong owner", func(_ *sp.Grant, r *store.SessionRecord) { r.Owner = uuid.NewString() }, true, 0},
		{"wrong prior generation", func(g *sp.Grant, _ *store.SessionRecord) { bad := "3"; g.PreviousGeneration = &bad }, true, 0},
		{"wrong controller", func(g *sp.Grant, _ *store.SessionRecord) { g.ControllerID = uuid.NewString() }, true, 0},
		{"wrong stop proof", func(g *sp.Grant, _ *store.SessionRecord) { g.StopProof.PreviousControllerInstanceID = uuid.NewString() }, true, 0},
		{"recovery replay", func(g *sp.Grant, r *store.SessionRecord) {
			r.Snapshot.ExecutionGeneration, r.Snapshot.Identity.ControllerInstanceID = g.ExecutionGeneration, g.ControllerInstanceID
			r.StopProof, _ = json.Marshal(g.StopProof)
		}, true, 2},
		{"same generation reconnect after recovery", func(g *sp.Grant, r *store.SessionRecord) {
			r.Snapshot.ExecutionGeneration, r.Snapshot.Identity.ControllerInstanceID = g.ExecutionGeneration, g.ControllerInstanceID
			r.StopProof, _ = json.Marshal(g.StopProof)
			g.PreviousGeneration, g.StopProof = nil, nil
		}, false, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: grantParent}
			var calls []string
			claim, sessionID, controller, oldInstance, newInstance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			previous := "1"
			g := sp.Grant{Protocol: sp.Protocol, ClaimID: claim, ControllerID: controller, ControllerInstanceID: newInstance, ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: oldInstance, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
			record := store.SessionRecord{Owner: p.UserID, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, ClaimID: claim, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{ProjectID: "project", TaskID: "task", ControllerID: controller, ControllerInstanceID: oldInstance}, Lifecycle: "active", LastEventSeq: "0", SessionRevision: "1"}}
			tc.change(&g, &record)
			dao := &taskGrantDAO{scopeTestDAO: &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "in_progress", Type: model.TaskTypeTask, Worker: &model.WorkerClaim{ClaimID: claim, UserID: p.UserID, State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb}}, record: record}}
			svc, err := NewScoped(taskGrantWriter{taskGrantScope{dao}}, core.NewEngine(nil), func(_ context.Context, _ store.SessionScope, caller model.Principal) (model.CredentialAuthorization, error) {
				ids := []scopepolicy.ScopeID{"session:produce"}
				if tc.retry {
					ids = append(ids, "worker:retry")
				}
				policy, e := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
				return model.CredentialAuthorization{Principal: caller, Profile: model.ScopedPATProfile, Policy: &policy}, e
			})
			if err != nil {
				t.Fatal(err)
			}
			result, err := svc.grantWithMediaRecovery(t.Context(), p, "project", "task", sessionID, g, func(context.Context) error { return nil }, svc.Execution.Grant)
			if tc.wantWrites > 0 {
				if err != nil || result.ClaimID != claim || result.ExecutionGeneration != "2" || result.ControllerInstanceID != newInstance || len(dao.writes) != tc.wantWrites {
					t.Fatalf("grant=%+v writes=%v err=%v", result, dao.writes, err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "session_conflict" || result.Token != "" || len(dao.writes) != 0 {
					t.Fatalf("grant=%+v writes=%v err=%v", result, dao.writes, err)
				}
			}
		})
	}
}

func TestTaskRecoveryGrantRechecksProducerAndRetryAroundMediaRecovery(t *testing.T) {
	for _, tc := range []struct {
		name                                string
		recovery, produce, retry, revoke    bool
		wantChecks, wantRecovery, wantGrant int
		wantAllowed                         bool
	}{
		{"recovery denied retry", true, true, false, false, 1, 0, 0, false},
		{"recovery denied producer", true, false, true, false, 1, 0, 0, false},
		{"recovery admitted", true, true, true, false, 2, 1, 1, true},
		{"revoked during media recovery", true, true, true, true, 2, 1, 1, false},
		{"ordinary reconnect", false, true, false, false, 1, 0, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: grantParent}
			var calls []string
			worker := &model.WorkerClaim{ClaimID: "claim", State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb}
			dao := &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "in_progress", Type: model.TaskTypeTask, Worker: worker}, record: store.SessionRecord{Owner: p.UserID, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session", ClaimID: "claim", ExecutionGeneration: "1"}}, Identity: sp.Identity{ProjectID: "project", TaskID: "task"}, Lifecycle: "active"}}}
			scope := scopeTestScope{dao: dao}
			checks, recoveries, grants := 0, 0, 0
			retry := tc.retry
			source := func(_ context.Context, actual store.SessionScope, caller model.Principal) (model.CredentialAuthorization, error) {
				checks++
				if actual != scope || caller != p {
					t.Fatal("credential identity or transaction changed")
				}
				ids := []scopepolicy.ScopeID{"session:read"}
				if tc.produce {
					ids = []scopepolicy.ScopeID{"session:produce"}
				}
				if retry {
					ids = append(ids, "worker:retry")
				}
				policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
				if err != nil {
					t.Fatal(err)
				}
				return model.CredentialAuthorization{Principal: caller, Profile: model.ScopedPATProfile, Policy: &policy}, nil
			}
			svc, err := NewScoped(scopeTestWriter{scope: scope}, core.NewEngine(nil), source)
			if err != nil {
				t.Fatal(err)
			}
			previous := "1"
			grant := sp.Grant{ExecutionGeneration: "2"}
			if tc.recovery {
				grant.PreviousGeneration = &previous
			}
			result, err := svc.grantWithMediaRecovery(t.Context(), p, "project", "task", "session", grant, func(context.Context) error {
				recoveries++
				if tc.revoke {
					retry = false
				}
				return nil
			}, func(ctx context.Context, actor model.Principal, project, task, id string, _ sp.Grant) (core.GrantResult, error) {
				grants++
				err := svc.browserFor(ctx, actor, project, task, id, core.ProducerAccess, func(*core.Access) error { return nil })
				if err != nil {
					return core.GrantResult{}, err
				}
				return core.GrantResult{Token: "grant"}, nil
			})
			if (err == nil) != tc.wantAllowed || (result.Token != "") != tc.wantAllowed || checks != tc.wantChecks || recoveries != tc.wantRecovery || grants != tc.wantGrant {
				t.Fatalf("result=%+v err=%v checks=%d recovery=%d grant=%d", result, err, checks, recoveries, grants)
			}
			if !tc.wantAllowed {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
					t.Fatalf("wrong refusal: %v", err)
				}
			}
		})
	}
}

func TestTaskRecoveryPreflightRejectsAnotherOwnerBeforeMediaRecovery(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: producerOwner, CredentialID: grantParent}
	var calls []string
	dao := &scopeTestDAO{calls: &calls, task: store.SessionTask{Status: "in_progress", Type: model.TaskTypeTask, Worker: &model.WorkerClaim{ClaimID: "claim", State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb}}, record: store.SessionRecord{Owner: "someone-else", Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: "session", ClaimID: "claim", ExecutionGeneration: "1"}}, Identity: sp.Identity{ProjectID: "project", TaskID: "task"}, Lifecycle: "active"}}}
	scope := scopeTestScope{dao: dao}
	svc, err := NewScoped(scopeTestWriter{scope: scope}, core.NewEngine(nil), func(_ context.Context, _ store.SessionScope, caller model.Principal) (model.CredentialAuthorization, error) {
		policy, e := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:produce", "worker:retry"}, 1)
		return model.CredentialAuthorization{Principal: caller, Profile: model.ScopedPATProfile, Policy: &policy}, e
	})
	if err != nil {
		t.Fatal(err)
	}
	previous := "1"
	_, err = svc.grantWithMediaRecovery(t.Context(), p, "project", "task", "session", sp.Grant{PreviousGeneration: &previous}, func(context.Context) error { t.Error("non-owner triggered recovery"); return nil }, func(context.Context, model.Principal, string, string, string, sp.Grant) (core.GrantResult, error) {
		t.Error("non-owner reached grant")
		return core.GrantResult{}, nil
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "session_conflict" {
		t.Fatalf("unexpected refusal: %v", err)
	}
}
