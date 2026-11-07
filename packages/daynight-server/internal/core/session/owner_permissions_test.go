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
	for _, role := range []string{"member", "admin"} {
		reader := listCredential(t, f, uuid.NewString(), model.PATCredential)
		if _, err := f.db.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) SELECT team_id,$2,$3 FROM project_ownership WHERE project_id=$1`, f.project, reader.UserID, role); err != nil {
			t.Fatal(err)
		}
		readers = append(readers, reader)
	}
	return readers
}

func TestTaskSessionOwnerPermissionsPreserveReadersAndMemberOwner(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, controlState())
	for _, reader := range sessionReaders(t, f) {
		current, err := f.s.Current(ctx, reader, f.project, f.task)
		if err != nil {
			t.Fatal(err)
		}
		snapshot := current["session"].(sp.Snapshot)
		initial, _, cursor, err := f.s.BrowserPoll(ctx, reader, f.project, f.task, v.SessionID, "")
		if err != nil || initial.Lifecycle != "active" || snapshot.Operations != (sp.Operations{}) || initial.Operations != (sp.Operations{}) || snapshot.Controls.Settings[0].Mutable || snapshot.Controls.Commands[0].Available {
			t.Fatal("non-owner lacked live read access or retained interaction authority", err)
		}
		publishState(t, f, v, controlState())
		_, events, _, err := f.s.BrowserPoll(ctx, reader, f.project, f.task, v.SessionID, cursor)
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
			_, err := f.s.Submit(ctx, reader, f.project, f.task, v.SessionID, controlCommand(v, kind))
			assertCommandAuthorization(t, err, "forbidden", nil)
		}
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	current, err := f.s.Current(ctx, f.p, f.project, f.task)
	if err != nil || !current["session"].(sp.Snapshot).Operations.CanSend || !current["session"].(sp.Snapshot).Controls.Settings[0].Mutable {
		t.Fatal("owner's project role determined interaction authority", err)
	}
	command := submitText(t, f, v)
	if offers, err := f.s.Poll(ctx, v.ControllerFence); err != nil || len(offers) != 1 {
		t.Fatal("member owner could not dispatch", offers, err)
	}
	begin, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID})
	if err != nil || begin["type"] != "operation_authorized" {
		t.Fatal("member owner could not begin native input", begin, err)
	}
}

func TestPersistedNonOwnerNativeOperationsCannotResumeExecution(t *testing.T) {
	for _, phase := range []string{"queued", "offered", "reconcile"} {
		t.Run(phase, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			publishState(t, f, v, idleState())
			command := submitText(t, f, v)
			if phase != "queued" {
				if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
					t.Fatal(err)
				}
			}
			actor := addMember(t, f, "admin")
			// A retained pre-policy operation still has a live body and valid credentials.
			if _, err := f.db.Pool.Exec(ctx, `UPDATE session_operations SET actor_user_id=$2,credential_id=$3,credential_kind=$4 WHERE operation_id=$1`, command.OperationID, actor.UserID, actor.CredentialID, actor.Kind); err != nil {
				t.Fatal(err)
			}
			_, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command)
			assertCommandAuthorization(t, err, "forbidden", nil)
			switch phase {
			case "queued":
				if offers, err := f.s.Poll(ctx, v.ControllerFence); err != nil || len(offers) != 0 {
					t.Fatal("non-owner's queued operation was offered", offers, err)
				}
			case "offered":
				assertRejectedBegin(t, f, v, command.OperationID)
			case "reconcile":
				apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: "not_submitted"}}, Final: true})
			}
			receipt, err := f.s.Operation(ctx, actor, f.project, f.task, v.SessionID, command.OperationID)
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
				view, err = f.s.CurrentTerminal(ctx, reader, f.project, f.task)
			} else {
				view, err = f.s.TerminalState(ctx, reader, f.project, f.task, f.message.SessionID)
			}
			if err != nil || view["connected"] != true || len(view["control"].(*v2.ControlState).AvailableActions) != 0 {
				t.Fatal("non-owner lacked terminal read access or retained control actions", view, err)
			}
		}
		req := v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: lease.ControlEpoch, Action: "acquire_control", BrowserClientID: f.browser}
		for _, message := range []v2.Message{f.msg("control_request", req), f.input(lease, "1", "non-owner input")} {
			_, err := f.s.SubmitTerminal(ctx, reader, f.project, f.task, f.message.SessionID, f.browser, message)
			assertCommandAuthorization(t, err, "forbidden", nil)
		}
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_grants SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
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
			if _, err := f.db.Pool.Exec(ctx, `UPDATE session_operations SET actor_user_id=$2,credential_id=$3,credential_kind=$4 WHERE operation_id=$1`, req.OperationID, actor.UserID, actor.CredentialID, actor.Kind); err != nil {
				t.Fatal(err)
			}
			_, err := f.s.SubmitTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.browser, f.msg("control_request", req))
			assertCommandAuthorization(t, err, "forbidden", nil)
			if phase == "queued" {
				if offers := f.poll(t, "1"); len(offers) != 0 {
					t.Fatal("retained non-owner control request was forwarded")
				}
			} else {
				digest, err := v2.ControlRequestDigest(actor.UserID, req)
				if err != nil {
					t.Fatal(err)
				}
				lease := v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: f.browser, ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}
				state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", Lease: &lease, InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}}
				f.worker(t, "1", f.msg("control_ack", v2.ControlAck{RequestDigest: digest, Durable: true, ControlState: state, Result: terminalResult(req.OperationID, "transport_completed", "")}))
			}
			if f.control(t).Lease != nil {
				t.Fatal("retained non-owner operation established a lease")
			}
		})
	}
}
