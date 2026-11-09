package session

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestBrowserBindingUsesRecordedSessionOwner(t *testing.T) {
	execution, r, task := taskControlAuthorizationFixture(controlState())
	r.Owner = "owner"
	r.Snapshot.Identity.ProjectID, r.Snapshot.Identity.TaskID = "project", "task"
	task.Worker.UserID = r.Owner
	op := &Operation{engine: execution.Engine}
	for _, user := range []string{"owner", "project member", "project administrator"} {
		t.Run(user, func(t *testing.T) {
			p := model.Principal{UserID: user}
			access := &Access{record: r}
			if err := op.BindTaskBrowser(context.Background(), access, &TaskAccess{task: task}, p, "project", "task"); err != nil {
				t.Fatal(err)
			}
			terminal := &TerminalAccess{record: &terminalRecord{Owner: v2.Owner{OwnerUserID: "owner", ProjectID: "project", TaskID: "task"}}}
			if err := op.BindTerminal(terminal, &TaskAccess{task: task}, p, "project", "task", false); err != nil {
				t.Fatal(err)
			}
			if access.write != (user == "owner") || terminal.write != (user == "owner") {
				t.Fatal("session control authority did not follow its recorded owner")
			}
		})
	}
}

func sessionReaders(t *testing.T, f fixture) []model.Principal {
	t.Helper()
	readers := []model.Principal{addMember(t, f, "member"), addMember(t, f, "admin")}
	for _, role := range []model.ProjectRole{model.ProjectMemberRole, model.ProjectAdmin} {
		reader := addMember(t, f, string(role))
		previous := f.dao.ProjectAccessFn
		f.dao.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
			if user != reader.UserID {
				return previous(ctx, user, project)
			}
			if project != f.project {
				t.Fatal("inherited reader changed Project identity")
			}
			return model.ProjectAccess{ProjectID: project, UserID: user, Role: role, OwnerTeam: model.TeamRef{ID: "team", Kind: "shared"}, TeamRole: &role}, nil
		}
		readers = append(readers, reader)
	}
	return readers
}

func fixtureMemberOwner(t *testing.T, f fixture) {
	t.Helper()
	previous := f.dao.ProjectAccessFn
	f.dao.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		if user != f.p.UserID {
			return previous(ctx, user, project)
		}
		if project != f.project {
			t.Fatal("member owner changed Project identity")
		}
		return model.ProjectAccess{ProjectID: project, UserID: user, Role: model.ProjectMemberRole}, nil
	}
}

func TestTaskSessionOwnerPermissionsPreserveReadersAndMemberOwner(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, controlState())
	for _, reader := range sessionReaders(t, f) {
		current, err := permissionCurrent(f, ctx, reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		snapshot := current["session"].(sp.Snapshot)
		initial, _, cursor, err := permissionBrowserPoll(f, ctx, reader, v, "")
		if err != nil || initial.Lifecycle != "active" || snapshot.Operations != (sp.Operations{}) || initial.Operations != (sp.Operations{}) || snapshot.Controls.Settings[0].Mutable || snapshot.Controls.Commands[0].Available {
			t.Fatal("non-owner lacked live read access or retained interaction authority", err)
		}
		publishState(t, f, v, controlState())
		_, events, _, err := permissionBrowserPoll(f, ctx, reader, v, cursor)
		if err != nil || len(events) == 0 {
			t.Fatal("reader lost live updates", err)
		}
		for _, event := range events {
			if event["kind"] == "snapshot" {
				view := event["payload"].(sp.Snapshot)
				if view.Operations != (sp.Operations{}) || view.Controls.Settings[0].Mutable || view.Controls.Commands[0].Available {
					t.Fatal("live update restored a non-owner's authority")
				}
			}
		}
		for _, kind := range []string{"send_message", "cancel", "interaction_response", "update_setting", "execute_command", "refresh_controls"} {
			_, err := fixtureSubmit(f, ctx, reader, v, controlCommand(v, kind), nil)
			assertCommandAuthorization(t, err, "forbidden", nil)
		}
	}
	fixtureMemberOwner(t, f)
	current, err := permissionCurrent(f, ctx, f.p, nil)
	if err != nil || !current["session"].(sp.Snapshot).Operations.CanSend || !current["session"].(sp.Snapshot).Controls.Settings[0].Mutable {
		t.Fatal("owner's project role determined interaction authority", err)
	}
	command := submitText(t, f, v)
	if offers, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SetSessionOperationEpoch": 1, "SaveSession": 1}); err != nil || len(offers) != 1 {
		t.Fatal("member owner could not dispatch", offers, err)
	}
	f.SelectReceiptWrite(t)
	f.SelectEpochWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = nil
	begin, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
	if err != nil || begin["type"] != "operation_authorized" {
		t.Fatal("member owner could not begin native input", begin, err)
	}
	f.SelectTouchWrite(t)
	f.SelectSessionWrite(t)
}

func TestPersistedNonOwnerNativeOperationsCannotResumeExecution(t *testing.T) {
	for _, phase := range []string{"queued", "offered", "reconcile"} {
		t.Run(phase, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			publishState(t, f, v, idleState())
			command := submitText(t, f, v)
			if phase != "queued" {
				if _, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SetSessionOperationEpoch": 1, "SaveSession": 1}); err != nil {
					t.Fatal(err)
				}
				f.SelectReceiptWrite(t)
				f.SelectEpochWrite(t)
				f.SelectSessionWrite(t)
				f.data.AcceptedIDs = nil
			}
			actor := addMember(t, f, "admin")
			// A retained pre-policy operation still has a live body and valid credentials.
			f.data.Operation.Actor = actor
			_, err := fixtureSubmit(f, ctx, f.p, v, command, map[string]int{"SessionOperation": 1})
			assertCommandAuthorization(t, err, "forbidden", nil)
			switch phase {
			case "queued":
				if offers, err := fixturePoll(f, ctx, v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SaveSession": 1}); err != nil || len(offers) != 0 {
					t.Fatal("non-owner's queued operation was offered", offers, err)
				}
				f.SelectReceiptWrite(t)
				f.SelectSessionWrite(t)
				f.data.AcceptedIDs = nil
			case "offered":
				assertRejectedBegin(t, f, v, command.OperationID)
			case "reconcile":
				if _, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: "not_submitted"}}, Final: true}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "UnreconciledSessionOperations": 1, "TouchSession": 1, "SaveSession": 1}); err != nil {
					t.Fatal(err)
				}
				f.SelectTouchWrite(t)
				f.SelectSessionWrite(t)
				f.SelectReceiptWrite(t)
				f.SelectEpochWrite(t)
			}
			receipt, err := permissionOperation(f, ctx, actor, v, command.OperationID)
			if err != nil || receipt.State != "rejected" {
				t.Fatal("retained non-owner operation was not rejected or became unreadable", receipt, err)
			}
		})
	}
}

func TestTerminalSessionOwnerPermissionsPreserveReadersAndMemberOwner(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	lease := f.acquire(t)
	for _, reader := range sessionReaders(t, f.fixture) {
		for _, current := range []bool{false, true} {
			var view map[string]any
			var err error
			if current {
				view, err = permissionTerminalRead(f.fixture, ctx, reader, f.message.SessionID, true, true)
			} else {
				view, err = permissionTerminalRead(f.fixture, ctx, reader, f.message.SessionID, false, true)
			}
			if err != nil || view["connected"] != true || len(view["control"].(*v2.ControlState).AvailableActions) != 0 {
				t.Fatal("non-owner lacked terminal read access or retained control actions", view, err)
			}
		}
		req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: lease.ControlEpoch, Action: "acquire_control", BrowserClientID: f.browser}
		for _, message := range []v2.Message{f.msg("control_request", req), f.input(lease, "1", "non-owner input")} {
			_, err := permissionTerminalSubmit(f.fixture, ctx, reader, f.message.SessionID, f.browser, message, false)
			assertCommandAuthorization(t, err, "forbidden", nil)
		}
	}
	fixtureMemberOwner(t, f.fixture)
	input := f.input(lease, "1", "member owner input")
	f.submit(t, input)
	if offers := f.poll(t, "1"); len(offers) != 1 || f.control(t).Lease == nil {
		t.Fatal("owner role demotion suspended its lease or blocked input", offers)
	}
}

func TestPersistedNonOwnerTerminalOperationsCannotAcquireControl(t *testing.T) {
	for _, phase := range []string{"queued", "dispatched"} {
		t.Run(phase, func(t *testing.T) {
			f := terminalControlSetup(t)
			ctx := context.Background()
			req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", Action: "acquire_control", BrowserClientID: f.browser}
			f.submit(t, f.msg("control_request", req))
			if phase == "dispatched" {
				f.poll(t, "1")
			}
			actor := terminalOtherActor(t, f)
			f.operations.operation(req.OperationID).Actor = actor
			_, err := permissionTerminalSubmit(f.fixture, ctx, f.p, f.message.SessionID, f.browser, f.msg("control_request", req), true)
			assertCommandAuthorization(t, err, "forbidden", nil)
			if phase == "queued" {
				if offers := f.pollWith(t, "1", 0); len(offers) != 0 {
					t.Fatal("retained non-owner control request was forwarded")
				}
			} else {
				digest, err := v2.ControlRequestDigest(actor.UserID, req)
				if err != nil {
					t.Fatal(err)
				}
				lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
				state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}}
				f.workerWith(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: digest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}), map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2})
			}
			if f.control(t).Lease != nil {
				t.Fatal("retained non-owner operation established a lease")
			}
		})
	}
}
