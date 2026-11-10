package session

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTerminalArchiveStatePreservesOriginalLedgerWithoutActions(t *testing.T) {
	for _, phase := range []string{"active", "completed", "released", "deleted"} {
		t.Run(phase, func(t *testing.T) {
			f := terminalControlSetup(t)
			ctx := context.Background()
			initial, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				phaseCtx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
				defer f.dao.FinishContext(phaseCtx)
				return f.s.TerminalState(phaseCtx, f.p, f.project, f.task, f.message.SessionID)
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(initial["control"].(*v2.ControlState).AvailableActions) == 0 {
				t.Fatal("active control fixture has no actions")
			}
			if phase != "active" {
				state := phase
				if phase == "deleted" {
					state = "completed"
				}
				endTerminalTask(t, f.fixture, model.WorkerState(state))
				if phase == "deleted" {
					f.data.TaskDeleted = true
				}
			}
			got, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				phaseCtx := f.fixture.TerminalPhase(ctx, true, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
				defer f.dao.FinishContext(phaseCtx)
				return f.s.TerminalArchiveState(phaseCtx, f.p, f.project, f.task, f.message.SessionID)
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"protocol", "schemaVersion", "projectionVersion", "sessionId", "claimId", "executionGeneration", "owner", "binding", "ledger", "recording"} {
				if !reflect.DeepEqual(got[key], initial[key]) {
					t.Fatalf("%s changed: %#v != %#v", key, got[key], initial[key])
				}
			}
			if len(got) != len(initial) || len(got["control"].(*v2.ControlState).AvailableActions) != 0 {
				t.Fatalf("archive state changed schema or exposed actions: %#v", got)
			}
			if phase != "active" && got["connected"] != false {
				t.Fatal("terminal claim appears connected")
			}
			ordinary, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				work := map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}
				if phase == "deleted" {
					work = map[string]int{"LockCredential": 0, "ProjectAccess": 0, "LockTerminal": 0}
				}
				phaseCtx := f.fixture.TerminalPhase(ctx, false, work)
				defer f.dao.FinishContext(phaseCtx)
				return f.s.TerminalState(phaseCtx, f.p, f.project, f.task, f.message.SessionID)
			})
			if phase == "deleted" {
				if err == nil {
					t.Fatal("ordinary state reopened a deleted task")
				}
				if _, err = fixtureTerminalHistory(f.fixture, f.s, ctx, f.p, f.project, f.task, "", 20, map[string]int{"LockCredential": 0, "ProjectAccess": 0, "TerminalHistory": 0}); err == nil {
					t.Fatal("ordinary history reopened a deleted task")
				}
			} else if err != nil {
				t.Fatal(err)
			} else if phase == "active" && len(ordinary["control"].(*v2.ControlState).AvailableActions) == 0 {
				t.Fatal("archive read removed ordinary control actions")
			}
		})
	}
}

func TestTerminalArchiveStateRequiresOriginalOwnerCredentialAndMembership(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		for _, actor := range []string{"browser", "member", "admin", "nonmember", "removed owner", "revoked", "expired"} {
			t.Run(actor+map[bool]string{false: "/active", true: "/deleted"}[deleted], func(t *testing.T) {
				f, m := terminalFixture(t)
				ctx := context.Background()
				if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
					phaseCtx := f.TerminalRegistrationPhase(ctx, map[string]int{"InsertTerminal": 1})
					defer f.dao.FinishContext(phaseCtx)
					return f.s.RegisterTerminal(phaseCtx, f.p, f.project, f.task, m)
				}); err != nil {
					t.Fatal(err)
				}
				if deleted {
					endTerminalTask(t, f, model.WorkerCompleted)
					f.data.TaskDeleted = true
				}
				p := f.p
				var err error
				switch actor {
				case "browser":
					p = listCredential(t, f, f.p.UserID, model.SessionCredential)
				case "member", "admin":
					p = addMember(t, f, actor)
				case "nonmember":
					p = listCredential(t, f, uuid.NewString(), model.PATCredential)
				case "removed owner":
					denyFixtureProject(t, f, p)
				case "revoked", "expired":
					revokeFixtureCredential(t, f, p)
				}
				if !deleted && (actor == "browser" || actor == "member" || actor == "admin") {
					if _, err = terminalStateStep(t, f, func() (map[string]any, error) {
						phaseCtx := f.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
						defer f.dao.FinishContext(phaseCtx)
						return f.s.TerminalState(phaseCtx, p, f.project, f.task, m.SessionID)
					}); err != nil {
						t.Fatal("ordinary member read must remain valid", err)
					}
				}
				if _, err = terminalStateStep(t, f, func() (map[string]any, error) {
					work := map[string]int{}
					if actor == "revoked" || actor == "expired" {
						work = map[string]int{"ProjectAccess": 0, "LockTerminal": 0}
					} else if actor == "nonmember" || actor == "removed owner" {
						work = map[string]int{"LockTerminal": 0}
					}
					phaseCtx := f.TerminalPhase(ctx, true, work)
					defer f.dao.FinishContext(phaseCtx)
					return f.s.TerminalArchiveState(phaseCtx, p, f.project, f.task, m.SessionID)
				}); err == nil {
					t.Fatal("unauthorized archive state")
				}
			})
		}
	}
}

func TestTerminalArchiveStatePreservesScopeAndClaimFence(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	finalizeFixture(t, f, m, doc)
	uploaded, err := fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, encode(doc), nil)
	if err != nil {
		t.Fatal(err)
	}
	selectTerminalArchiveReadback(t, f, m.SessionID, encode(doc), uploaded.Payload.(v2.Receipt))
	f.data.Task.Worker.ClaimID = uuid.NewString()
	state, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phaseCtx := f.TerminalPhase(ctx, true, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(phaseCtx)
		return f.s.TerminalArchiveState(phaseCtx, f.p, f.project, f.task, m.SessionID)
	})
	if err != nil || state["claimId"] != m.ClaimID || state["archive"].(v2.ArchiveStatus).State != "ready" || state["ledger"].(v2.GenerationLedger).FinalizationID == nil {
		t.Fatal(state, err)
	}
	otherTask := uuid.NewString()
	priorTask := f.dao.LockArchiveTaskFn
	f.dao.LockArchiveTaskFn = func(ctx context.Context, project, taskID string) (store.SessionTask, bool, error) {
		if project == f.project && taskID == otherTask {
			return store.SessionTask{Status: "done"}, false, nil
		}
		return priorTask(ctx, project, taskID)
	}
	otherSession := uuid.NewString()
	priorTerminal := f.dao.LockTerminalFn
	f.dao.LockTerminalFn = func(ctx context.Context, id string) ([]byte, error) {
		if id == otherSession {
			return nil, model.ErrNotFound
		}
		return priorTerminal(ctx, id)
	}
	for _, scope := range [][3]string{{f.project, otherTask, m.SessionID}, {uuid.NewString(), f.task, m.SessionID}, {f.project, f.task, otherSession}} {
		if _, err = terminalStateStep(t, f, func() (map[string]any, error) {
			work := map[string]int{}
			if scope[0] != f.project {
				work = map[string]int{"LockCredential": 0, "ProjectAccess": 0, "LockTerminal": 0}
			}
			phaseCtx := f.TerminalPhase(ctx, true, work)
			defer f.dao.FinishContext(phaseCtx)
			return f.s.TerminalArchiveState(phaseCtx, f.p, scope[0], scope[1], scope[2])
		}); err == nil {
			t.Fatal("foreign scope or session was accepted", scope)
		}
	}
}
