//go:build integration

package main

import (
	"net/http"
	"net/url"
	"strings"
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
	t.Run("without pagination or S2S keys", func(t *testing.T) {
		f := newFixtureConfigured(t, false, nil, "DAYNIGHT_S2S_SHARED_KEY=")
		plain := &http.Client{Timeout: 5 * time.Second}
		t.Cleanup(plain.CloseIdleConnections)
		resp, _ := usageRequest(t, f, plain, http.MethodGet, "/api/usage/v1/capabilities", "", "", "", http.StatusUnauthorized)
		if resp.Header.Get("X-Request-ID") == "" {
			t.Fatal("unauthenticated capability response lacks request ID")
		}
		resp, data := usageRequest(t, f, f.client, http.MethodGet, "/api/usage/v1/capabilities", "", "", "", http.StatusOK)
		capabilities := usageDecode[struct {
			Protocol     string `json:"protocol"`
			WriteEnabled bool   `json:"writeEnabled"`
			TaskSummary  bool   `json:"taskSummary"`
			Aggregates   bool   `json:"aggregates"`
		}](t, data)
		if resp.Header.Get("X-Request-ID") == "" || capabilities.Protocol != core.Protocol || !capabilities.WriteEnabled || !capabilities.TaskSummary || !capabilities.Aggregates {
			t.Fatalf("unexpected usage capabilities: %+v", capabilities)
		}
		project := createProject(t, f, "Usage without keys")
		task := createTask(t, f, project, "Empty usage", nil)
		summary := requestJSON[model.UsageSummary](t, f, http.MethodGet, "/api/projects/"+project.ID+"/tasks/"+task.ID+"/usage/v1/summary", nil, http.StatusOK)
		if summary.MeasurementRecords != "0" {
			t.Fatal("new task has unexpected measurements")
		}
	})
	t.Run("report and paginate", usageReportingFlow)
}

func usageReportingFlow(t *testing.T) {
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
	// More than one result exercises continuation through the real HTTP and SQL path.
	keys := map[string]bool{event["sourceKey"].(string): true}
	for i := 0; i < 2; i++ {
		next := make(map[string]any, len(event))
		for k, v := range event {
			next[k] = v
		}
		next["eventId"] = uuid.NewString()
		next["sourceKey"] = "copilot-event-v1:" + uuid.NewString()
		keys[next["sourceKey"].(string)] = true
		ack := requestJSON[app.BatchResult](t, &grantFixture, "POST", "/api/usage/v1/states/"+stateID+"/batches", map[string]any{"protocol": core.Protocol, "batchId": uuid.NewString(), "events": []any{next}}, 200)
		if len(ack.Results) != 1 || ack.Results[0].Outcome != "inserted" {
			t.Fatal("additional measurement was not inserted")
		}
	}
	path := "/api/projects/" + project.ID + "/tasks/" + task.ID + "/usage/v1/records?kind=measurement&limit=1"
	cursor := ""
	var lastTime time.Time
	lastID := ""
	snapshot := ""
	for i := 0; i < 3; i++ {
		pagePath := path
		if cursor != "" {
			pagePath += "&cursor=" + url.QueryEscape(cursor)
		}
		resp, data := usageRequest(t, f, f.client, http.MethodGet, pagePath, "", "", "", http.StatusOK)
		page := usageDecode[app.RecordsPage](t, data)
		if resp.Header.Get("X-Request-ID") == "" || len(page.Items) != 1 || core.Value(page.Items[0].StateID) != stateID {
			t.Fatal("measurement page has incorrect identity or request ID")
		}
		item := page.Items[0]
		key := core.Value(item.SourceKey)
		if !keys[key] || i > 0 && (item.CreatedAt.Before(lastTime) || item.CreatedAt.Equal(lastTime) && item.ID <= lastID) {
			t.Fatal("measurement pages duplicated, omitted or reordered a record")
		}
		delete(keys, key)
		lastTime, lastID = item.CreatedAt, item.ID
		if i == 0 {
			snapshot = page.SnapshotToken
		} else if page.SnapshotToken != snapshot {
			t.Fatal("snapshot changed between pages")
		}
		if i < 2 {
			if page.NextCursor == nil || *page.NextCursor == "" || strings.Contains(*page.NextCursor, ".") {
				t.Fatal("expected an unsigned continuation cursor")
			}
			cursor = *page.NextCursor
		} else if page.NextCursor != nil {
			t.Fatal("last measurement page has a continuation cursor")
		}
	}
	if len(keys) != 0 {
		t.Fatal("measurement pages did not contain all inserted records")
	}
	after := requestJSON[api.Task](t, f, "GET", taskPath(task), nil, 200)
	if before.Version != after.Version || before.UpdatedAt != after.UpdatedAt {
		t.Fatal("usage mutated Task version or updatedAt")
	}
}
