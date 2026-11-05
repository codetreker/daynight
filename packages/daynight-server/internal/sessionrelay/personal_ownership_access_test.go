package sessionrelay

import (
	"context"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func makeRelayOwnerInheritedOnly(t *testing.T, f fixture) string {
	t.Helper()
	ctx := context.Background()
	var previousTeam string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&previousTeam); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=(SELECT id FROM teams WHERE personal_user_id=$2),version=version+1,updated_at=statement_timestamp() WHERE project_id=$1`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	return previousTeam
}

func TestInheritedOnlySessionOwnerRetainsReadControlAndDispatchAdmission(t *testing.T) {
	f, snapshot := connectFixture(t)
	previousTeam := makeRelayOwnerInheritedOnly(t, f)
	ctx := context.Background()
	publishState(t, f, snapshot, idleState())
	if _, err := f.s.Current(ctx, f.p, f.project, f.task); err != nil {
		t.Fatal("inherited-only current Session", err)
	}
	if _, _, _, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, snapshot.SessionID, ""); err != nil {
		t.Fatal("inherited-only browser stream", err)
	}
	grant, err := f.s.Grant(ctx, f.p, f.project, f.task, snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: snapshot.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal("inherited-only controller grant", err)
	}
	if err := f.s.AuthenticateController(ctx, grant.Token); err != nil {
		t.Fatal("controller authentication ignored inherited access", err)
	}
	command := submitText(t, f, snapshot)
	if operation, err := f.s.Operation(ctx, f.p, f.project, f.task, snapshot.SessionID, command.OperationID); err != nil || operation.State != "accepted" {
		t.Fatalf("inherited-only operation read: %#v %v", operation, err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1,updated_at=statement_timestamp() WHERE project_id=$1`, f.project, previousTeam); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Current(ctx, f.p, f.project, f.task); err == nil {
		t.Fatal("Session read retained a removed inherited source")
	}
	if err := f.s.AuthenticateController(ctx, grant.Token); err == nil {
		t.Fatal("controller authentication retained removed inherited access")
	}
	offers, err := f.s.Poll(ctx, snapshot.ControllerFence)
	assertAdmissionDenied(t, err)
	if len(offers) != 0 {
		t.Fatalf("dispatch offered work after its inherited requester lost access: %#v", offers)
	}
}

func TestInheritedOnlySessionAdmissionDoesNotLockOwnershipOrTeamSources(t *testing.T) {
	f := setup(t)
	previousTeam := makeRelayOwnerInheritedOnly(t, f)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := f.s.DB.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if admin, err := member(ctx, tx, f.p, f.project, time.Now()); err != nil || !admin {
		t.Fatal("inherited-only Session admission", admin, err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2,version=version+1,updated_at=statement_timestamp() WHERE project_id=$1`, f.project, previousTeam); err != nil {
		t.Fatal("ordinary Session admission held a Thread ownership fence", err)
	}
	_, err = member(ctx, tx, f.p, f.project, time.Now())
	assertAdmissionDenied(t, err)
}

func TestInheritedOnlyTerminalOwnerRetainsCurrentStateAndWorkerBinding(t *testing.T) {
	f, message := terminalFixture(t)
	makeRelayOwnerInheritedOnly(t, f)
	ctx := context.Background()
	if _, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, message); err != nil {
		t.Fatal("inherited-only terminal registration", err)
	}
	if err := f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, message.SessionID, message.Envelope, "1"); err != nil {
		t.Fatal("inherited-only terminal Worker connection", err)
	}
	if _, err := f.s.CurrentTerminal(ctx, f.p, f.project, f.task); err != nil {
		t.Fatal("inherited-only terminal current state", err)
	}
	if _, err := f.s.TerminalState(ctx, f.p, f.project, f.task, message.SessionID); err != nil {
		t.Fatal("inherited-only terminal state", err)
	}
}
