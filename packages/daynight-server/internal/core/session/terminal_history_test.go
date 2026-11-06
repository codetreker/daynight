package session

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestTerminalArchiveStatePreservesOriginalLedgerWithoutActions(t *testing.T) {
	for _, phase := range []string{"active", "completed", "released", "deleted"} {
		t.Run(phase, func(t *testing.T) {
			f := terminalControlSetup(t)
			ctx := context.Background()
			initial, err := f.s.TerminalState(ctx, f.p, f.project, f.task, f.message.SessionID)
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
				ended := endArchiveTask(t, f.fixture, state)
				if phase == "deleted" {
					deleteArchiveTask(t, f.fixture, ended.Version)
				}
			}
			got, err := f.s.TerminalArchiveState(ctx, f.p, f.project, f.task, f.message.SessionID)
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
			ordinary, err := f.s.TerminalState(ctx, f.p, f.project, f.task, f.message.SessionID)
			if phase == "deleted" {
				if err == nil {
					t.Fatal("ordinary state reopened a deleted task")
				}
				if _, err = f.s.TerminalHistory(ctx, f.p, f.project, f.task, "", 20); err == nil {
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
				if _, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m); err != nil {
					t.Fatal(err)
				}
				if deleted {
					ended := endArchiveTask(t, f, "completed")
					deleteArchiveTask(t, f, ended.Version)
				}
				p := f.p
				var err error
				switch actor {
				case "browser":
					p = listCredential(t, f, f.p.UserID, model.SessionCredential)
				case "member", "admin", "nonmember":
					p = listCredential(t, f, uuid.NewString(), model.PATCredential)
					if actor != "nonmember" {
						_, err = f.db.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,$3)`, f.project, p.UserID, actor)
					}
				case "removed owner":
					_, err = f.db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, p.UserID)
				case "revoked":
					_, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, p.CredentialID)
				case "expired":
					_, err = f.db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE id=$1`, p.CredentialID)
				}
				if err != nil {
					t.Fatal(err)
				}
				if !deleted && (actor == "browser" || actor == "member" || actor == "admin") {
					if _, err = f.s.TerminalState(ctx, p, f.project, f.task, m.SessionID); err != nil {
						t.Fatal("ordinary member read must remain valid", err)
					}
				}
				if _, err = f.s.TerminalArchiveState(ctx, p, f.project, f.task, m.SessionID); err == nil {
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
	if _, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, encode(doc)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{claimId}',to_jsonb($2::text))::text WHERE task_id=$1 AND name='worker'`, f.task, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	state, err := f.s.TerminalArchiveState(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || state["claimId"] != m.ClaimID || state["archive"].(v2.ArchiveStatus).State != "ready" || state["ledger"].(v2.GenerationLedger).FinalizationID == nil {
		t.Fatal(state, err)
	}
	otherTask := uuid.NewString()
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Other','done')`, otherTask, f.project); err != nil {
		t.Fatal(err)
	}
	for _, scope := range [][3]string{{f.project, otherTask, m.SessionID}, {uuid.NewString(), f.task, m.SessionID}, {f.project, f.task, uuid.NewString()}} {
		if _, err = f.s.TerminalArchiveState(ctx, f.p, scope[0], scope[1], scope[2]); err == nil {
			t.Fatal("foreign scope or session was accepted", scope)
		}
	}
}
