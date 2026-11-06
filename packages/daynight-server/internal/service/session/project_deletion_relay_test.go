package session

import (
	"context"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

func TestDeletedProjectRetiresWebRelayAndLeavesIndependentSessions(t *testing.T) {
	for _, local := range []bool{true, false} {
		t.Run(map[bool]string{true: "same-instance", false: "other-instance"}[local], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			f, bound := serviceBoundBot(t, newServiceFixture(t), nil)
			input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
			test, err := f.service.RegisterTest(ctx, f.owner, input)
			if err != nil {
				t.Fatal(err)
			}
			web := f.connectWeb(t, f.registerWeb(t))
			native := "native"
			state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
			if _, err = f.service.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: web.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
				t.Fatal(err)
			}
			type pageResult struct {
				page map[string]any
				err  error
			}
			pending := make(chan pageResult, 1)
			go func() {
				page, err := f.service.Timeline(ctx, f.owner, f.project, f.task, web.SessionID, "tail", "", 2)
				pending <- pageResult{page, err}
			}()
			var request map[string]any
			ticker := time.NewTicker(time.Millisecond)
			defer ticker.Stop()
			for request == nil {
				offers, e := f.service.Poll(ctx, web.ControllerFence)
				if e != nil {
					t.Fatal(e)
				}
				for _, o := range offers {
					if o["type"] == "content_request" {
						request = o
						break
					}
				}
				if request == nil {
					select {
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-ticker.C:
					}
				}
			}
			if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
				t.Fatal(err)
			}
			if _, err = f.db.Pool.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"draining"'),draining_until=now()+interval '1 minute' WHERE id=$1`, web.SessionID); err != nil {
				t.Fatal(err)
			}
			if _, err = f.service.Poll(ctx, web.ControllerFence); err != nil {
				t.Fatalf("draining relay should remain connected before deletion: %v", err)
			}
			engine := f.service.engine
			if !local {
				engine = core.NewEngine(nil)
				defer engine.Stop(context.Background())
			}
			receipt, err := projectservice.NewProjects(f.db, engine).Delete(ctx, f.owner, f.project)
			if err != nil || !receipt.Deleted {
				t.Fatalf("delete: %+v %v", receipt, err)
			}
			_, err = f.service.Poll(ctx, web.ControllerFence)
			requireServiceError(t, err, "not_found")
			_, _, _, err = f.service.BrowserPoll(ctx, f.owner, f.project, f.task, web.SessionID, "")
			requireServiceError(t, err, "not_found")
			result := &sp.ContentResult{Kind: "timeline", HistoryEpoch: web.HistoryEpoch, Items: []sp.TimelineEntry{}, Resources: []sp.Resource{}}
			_, err = f.service.Handle(ctx, sp.ControllerMessage{Type: "content_response", ControllerFence: web.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: "0", ContentResult: result})
			requireServiceError(t, err, "not_found")
			if local {
				select {
				case got := <-pending:
					requireServiceError(t, got.err, "not_found")
					if got.page != nil {
						t.Fatal("retired request exposed content")
					}
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			} else {
				cancel()
				got := <-pending
				if got.err == nil || got.page != nil {
					t.Fatal("other instance returned stale content")
				}
			}
			checkCtx := context.Background()
			if _, err = f.service.TestSnapshot(checkCtx, f.owner, test.SessionID); err != nil {
				t.Fatalf("independent test session: %v", err)
			}
			if _, err = f.service.TestSnapshot(checkCtx, f.owner, bound.Session.SessionID); err != nil {
				t.Fatalf("bot session: %v", err)
			}
			if _, err = botservice.New(f.db).Get(checkCtx, f.owner, bound.Bot.ID); err != nil {
				t.Fatalf("bot: %v", err)
			}
		})
	}
}

func TestDeletedProjectRetiresTerminalRelay(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	f := newServiceFixture(t)
	f.service.SetOrigin("https://daynight.example")
	if _, err := f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agentControlMode}','"herdr"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	pane := "pane"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: f.registration.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, OwnerUserID: f.owner.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}, Binding: v2.Binding{InstanceID: "instance", SessionID: "herdr", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_one"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	if _, err := f.service.RegisterTerminal(ctx, f.owner, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.PollTerminal(ctx, f.owner, f.project, f.task, m.SessionID, m.Envelope, "1"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.TerminalState(ctx, f.owner, f.project, f.task, m.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	receipt, err := projectservice.NewProjects(f.db, f.service.engine).Delete(ctx, f.owner, f.project)
	if err != nil || !receipt.Deleted {
		t.Fatalf("delete: %+v %v", receipt, err)
	}
	_, err = f.service.PollTerminal(ctx, f.owner, f.project, f.task, m.SessionID, m.Envelope, "1")
	requireServiceError(t, err, "not_found")
	_, err = f.service.TerminalState(ctx, f.owner, f.project, f.task, m.SessionID)
	requireServiceError(t, err, "not_found")
}
