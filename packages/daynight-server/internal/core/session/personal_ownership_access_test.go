package session

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func permissionCurrent(f fixture, ctx context.Context, principal model.Principal, work map[string]int) (map[string]any, error) {
	phase := f.TaskPhase(ctx, mergeFixtureCounts(map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1}, work))
	defer f.dao.FinishContext(phase)
	return f.s.Current(phase, principal, f.project, f.task)
}

func permissionBrowserPoll(f fixture, ctx context.Context, principal model.Principal, snapshot sp.Snapshot, cursor string) (sp.Snapshot, []map[string]any, string, error) {
	phase := f.BrowserPhase(ctx, nil)
	defer f.dao.FinishContext(phase)
	return f.s.BrowserPoll(phase, principal, f.project, f.task, snapshot.SessionID, cursor)
}

func permissionGrant(f fixture, ctx context.Context, snapshot sp.Snapshot, input sp.Grant) (GrantResult, error) {
	phase := f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Grant(phase, f.p, f.project, f.task, snapshot.SessionID, input)
}

func permissionAuthenticate(f fixture, ctx context.Context, token string) error {
	phase := f.GrantPhase(ctx, nil)
	defer f.dao.FinishContext(phase)
	return f.s.AuthenticateController(phase, token)
}

func permissionOperation(f fixture, ctx context.Context, principal model.Principal, snapshot sp.Snapshot, id string) (sp.Operation, error) {
	phase := f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1})
	defer f.dao.FinishContext(phase)
	return f.s.Operation(phase, principal, f.project, f.task, snapshot.SessionID, id)
}

func permissionTerminalRead(f fixture, ctx context.Context, principal model.Principal, id string, current, lease bool) (map[string]any, error) {
	work := map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1}
	if lease {
		work["LockCredential"], work["ProjectAccess"] = 2, 2
	}
	var phase context.Context
	if current {
		work["CurrentTerminalSession"], work["LockTerminal"] = 1, 1
		phase = f.TaskPhase(ctx, work)
	} else {
		phase = f.TerminalPhase(ctx, false, work)
	}
	defer f.dao.FinishContext(phase)
	if current {
		return f.s.CurrentTerminal(phase, principal, f.project, f.task)
	}
	return f.s.TerminalState(phase, principal, f.project, f.task, id)
}

func permissionTerminalSubmit(f fixture, ctx context.Context, principal model.Principal, id, browser string, message v2.Message, retained bool) (v2.Message, error) {
	work := map[string]int{}
	if retained {
		work["TerminalOperation"] = 1
	}
	phase := f.TerminalPhase(ctx, false, work)
	defer f.dao.FinishContext(phase)
	return f.s.SubmitTerminal(phase, principal, f.project, f.task, id, browser, message)
}

func makeRelayOwnerInheritedOnly(t *testing.T, f fixture) {
	t.Helper()
	previous := f.dao.ProjectAccessFn
	f.dao.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		if user != f.p.UserID {
			return previous(ctx, user, project)
		}
		if project != f.project {
			t.Fatal("inherited access changed Project identity")
		}
		role := model.ProjectAdmin
		return model.ProjectAccess{UserID: user, ProjectID: project, Role: role, OwnerTeam: model.TeamRef{ID: "personal-team", Kind: "personal"}, TeamRole: &role}, nil
	}
}

func TestInheritedOnlySessionOwnerRetainsReadControlAndDispatchAdmission(t *testing.T) {
	f, snapshot := connectFixture(t)
	makeRelayOwnerInheritedOnly(t, f)
	ctx := context.Background()
	publishState(t, f, snapshot, idleState())
	if _, err := permissionCurrent(f, ctx, f.p, nil); err != nil {
		t.Fatal("inherited-only current Session", err)
	}
	if _, _, _, err := permissionBrowserPoll(f, ctx, f.p, snapshot, ""); err != nil {
		t.Fatal("inherited-only browser stream", err)
	}
	grant, err := permissionGrant(f, ctx, snapshot, sp.Grant{Protocol: sp.Protocol, ClaimID: snapshot.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal("inherited-only controller grant", err)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	if err := permissionAuthenticate(f, ctx, grant.Token); err != nil {
		t.Fatal("controller authentication ignored inherited access", err)
	}
	command := submitText(t, f, snapshot)
	if operation, err := permissionOperation(f, ctx, f.p, snapshot, command.OperationID); err != nil || operation.State != "accepted" {
		t.Fatalf("inherited-only operation read: %#v %v", operation, err)
	}
	denyFixtureProject(t, f, f.p)
	if _, err := permissionCurrent(f, ctx, f.p, map[string]int{"CurrentTaskSession": 0, "SessionBotID": 0, "LockSession": 0}); err == nil {
		t.Fatal("Session read retained a removed inherited source")
	}
	if err := permissionAuthenticate(f, ctx, grant.Token); err == nil {
		t.Fatal("controller authentication retained removed inherited access")
	}
	offers, err := fixturePoll(f, ctx, snapshot.ControllerFence, nil)
	assertAdmissionDenied(t, err)
	if len(offers) != 0 {
		t.Fatalf("dispatch offered work after its inherited requester lost access: %#v", offers)
	}
}

func TestInheritedOnlyTerminalOwnerRetainsCurrentStateAndWorkerBinding(t *testing.T) {
	f, message := terminalFixture(t)
	makeRelayOwnerInheritedOnly(t, f)
	ctx := context.Background()
	registration := f.TerminalRegistrationPhase(ctx, map[string]int{"InsertTerminal": 1})
	if _, err := terminalRegistrationStep(t, f, message.SessionID, func() (v2.Message, error) { return f.s.RegisterTerminal(registration, f.p, f.project, f.task, message) }); err != nil {
		t.Fatal("inherited-only terminal registration", err)
	}
	f.dao.FinishContext(registration)
	binding := f.TerminalPhase(ctx, false, map[string]int{"SaveTerminal": 1})
	if err := terminalErrorStep(t, f, func() error {
		return f.s.BindTerminalConnection(binding, f.p, f.project, f.task, message.SessionID, message.Envelope, "1")
	}); err != nil {
		t.Fatal("inherited-only terminal Worker connection", err)
	}
	f.dao.FinishContext(binding)
	if _, err := permissionTerminalRead(f, ctx, f.p, message.SessionID, true, false); err != nil {
		t.Fatal("inherited-only terminal current state", err)
	}
	if _, err := permissionTerminalRead(f, ctx, f.p, message.SessionID, false, false); err != nil {
		t.Fatal("inherited-only terminal state", err)
	}
}
