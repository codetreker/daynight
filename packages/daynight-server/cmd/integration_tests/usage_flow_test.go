//go:build integration

package main

import (
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestServerAPIUsageNormalFlow(t *testing.T) {
	// This is synthetic protocol evidence, not Provider qualification.
	profile := "copilot-event-1.0.11-v1"
	version := "1.0.11+1.0.105"
	f := newFixtureConfigured(t, false, nil, "DAYNIGHT_USAGE_WRITE_ENABLED=true", "DAYNIGHT_USAGE_QUALIFIED_PROFILES="+profile+"@"+version)
	client := *f.client
	client.Transport = sessionWorkerTransport{next: client.Transport}
	f.client = &client
	project := createProject(t, f, "Usage integration")
	task := createTask(t, f, project, "Measured execution", map[string]any{"assignedTo": f.userID, "status": "todo"})
	task = requestJSON[api.Task](t, f, "PATCH", taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, 200)
	claim, worker, worktree := uuid.NewString(), uuid.NewString(), uuid.NewString()
	task = requestJSON[api.Task](t, f, "POST", taskPath(task)+"/worker-claim", map[string]any{"version": task.Version, "claimId": claim, "workerId": worker, "worktreeId": worktree, "machine": map[string]any{"id": uuid.NewString(), "name": "Usage synthetic controller"}, "platform": "linux", "agent": "copilot", "agentControlMode": "web"}, 200)
	base := taskPath(task) + "/sessions"
	registration := sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: claim, WorkerID: worker, WorktreeID: worktree, Provider: "copilot", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	registered := requestJSON[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f, "POST", base, registration, 200).Session
	controllerGrant := requestJSON[struct {
		Token string `json:"token"`
	}](t, f, "POST", base+"/"+registered.SessionID+"/controller-grant", sp.Grant{Protocol: sp.Protocol, ClaimID: claim, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}, 200)
	controller := sessionFlowDial(t, f, "/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + controllerGrant.Token}}})
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: registered.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: "copilot", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0"})
	welcome := sessionFlowRead(t, f, controller)
	sessionFlowKind(t, welcome, "welcome")
	connected, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	native := "usage-native-" + uuid.NewString()
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, State: &sp.State{NativeSessionID: &native, InitialInputState: connected.InitialInputState, Synchronized: true, Activity: "initializing"}, PendingInteractions: []sp.TimelineEntry{}})
	sessionFlowKind(t, sessionFlowRead(t, f, controller), "sync_ack")
	before := requestJSON[api.Task](t, f, "GET", taskPath(task), nil, 200)
	stateID := uuid.NewString()
	usageRegistration := app.Registration{Protocol: core.Protocol, StateID: stateID, SessionID: registered.SessionID, Generation: "1", ControllerInstanceID: registration.ControllerInstanceID, ConnectionEpoch: connected.ConnectionEpoch, NativeSessionID: native, ProfileID: profile, ProviderVersion: version, RegistrationID: uuid.NewString()}
	result := requestJSON[app.RegistrationResult](t, f, "POST", "/api/usage/v1/registrations", usageRegistration, 201)
	if result.Grant == nil || result.Grant.Token == "" {
		t.Fatal("missing usage grant")
	}
	grantFixture := *f
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	grantFixture.client = &http.Client{Timeout: 5 * time.Second, Transport: tokenTransport{token: result.Grant.Token, next: transport}}
	event := map[string]any{"eventId": uuid.NewString(), "kind": "measurement", "originatingStateId": stateID, "sourceKey": "copilot-event-v1:" + uuid.NewString(), "nativeTurnId": nil, "nativeCallId": nil, "model": "synthetic-model", "profileId": profile, "revisionAuthority": "immutable", "sourceRevision": "1", "finality": "final", "disposition": "active", "aggregationRole": "counted", "includedInSourceKey": nil, "metrics": model.UsageMetrics{Output: core.Ptr("9007199254740993")}, "nativeMetrics": map[string]any{"outputTokens": "9007199254740993"}, "reasonCodes": []string{}, "observedAt": time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)}
	input := map[string]any{"protocol": core.Protocol, "batchId": uuid.NewString(), "events": []any{event}}
	for i := 0; i < 2; i++ {
		ack := requestJSON[app.BatchResult](t, &grantFixture, "POST", "/api/usage/v1/states/"+stateID+"/batches", input, 200)
		if len(ack.Results) != 1 || ack.Results[0].EventID != event["eventId"] {
			t.Fatal(ack)
		}
		want := "inserted"
		if i > 0 {
			want = "duplicate"
		}
		if ack.Results[0].Outcome != want {
			t.Fatal(ack)
		}
	}
	summaryURL := "/api/projects/" + project.ID + "/tasks/" + task.ID + "/usage/v1/summary"
	summary := requestJSON[model.UsageSummary](t, f, "GET", summaryURL, nil, 200)
	if core.Value(summary.Metrics["outputTokens"].Known) != "9007199254740993" || summary.Metrics["totalTokens"].Known != nil || summary.MeasurementRecords != "1" {
		t.Fatal(summary)
	}
	f.request(t, "GET", summaryURL, "", nil, 304, http.Header{"If-None-Match": {`"` + summary.ETag + `"`}})
	page := requestJSON[app.RecordsPage](t, f, "GET", "/api/projects/"+project.ID+"/tasks/"+task.ID+"/usage/v1/records?kind=measurement&limit=100", nil, 200)
	if len(page.Items) != 1 || core.Value(page.Items[0].StateID) != stateID {
		t.Fatal(page)
	}
	after := requestJSON[api.Task](t, f, "GET", taskPath(task), nil, 200)
	if before.Version != after.Version || before.UpdatedAt != after.UpdatedAt {
		t.Fatal("usage mutated Task version or updatedAt")
	}
}
