package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestWorkerSnapshotsHTTPIdentityOriginAndCurrentPermissions(t *testing.T) {
	var logs bytes.Buffer
	f := newWorkerHTTPFixture(t, &logs)
	admitted := make(chan struct{}, 1)
	completed := make(chan struct{}, 1)
	stopping := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		select {
		case <-admitted:
		case <-stopping:
			return
		}
		defer func() { completed <- struct{}{} }()
		f.handler.ServeHTTP(w, request)
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(stopping) })
	alice := defaultHTTPPrincipal()
	alice.Kind = model.SessionCredential
	bob := model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.SessionCredential}
	var actor *model.Principal
	origin := ""
	f.send = func(method, path, body string) *httptest.ResponseRecorder {
		request, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", "project-test")
		if actor != nil {
			f.tx.WriteIdentityCall = newHTTPTestStoreForPrincipal(t, *actor).WriteIdentityCall
			f.handler.principal = *actor
			if actor.Kind == model.SessionCredential {
				request.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: httpTestToken(model.SessionCredential)})
			} else {
				request.Header.Set("Authorization", "Bearer "+httpTestToken(actor.Kind))
			}
		} else {
			f.tx.WriteIdentityCall = nil
		}
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		// The request barrier publishes the scripted facts to the serving goroutine.
		admitted <- struct{}{}
		client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		<-completed
		if err != nil {
			t.Fatal(err)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		recorder := httptest.NewRecorder()
		recorder.Code = response.StatusCode
		for key, values := range response.Header {
			recorder.Header()[key] = append([]string(nil), values...)
		}
		_, err = recorder.Body.Write(data)
		if err != nil {
			t.Fatal(err)
		}
		return recorder
	}
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	assertProjectError(t, f.send(http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusUnauthorized, "unauthenticated")
	actor = &alice
	origin = "https://foreign.example"
	assertProjectError(t, f.send(http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusForbidden, "forbidden")
	origin = configuredTestConfig().PublicOrigin
	snapshot := model.WorkerSnapshot{UserID: alice.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}}
	f.handler.principal = alice
	f.report(t, id, body, nil, nil, snapshot)
	actor = &bob
	origin = ""
	f.handler.principal = bob
	calls := 0
	f.read(t, &workerHTTPReader{t: t, WorkerCall: func(_ context.Context, u, w string, now time.Time) (model.WorkerSnapshot, error) {
		calls++
		if u != bob.UserID || w != id || now != f.now {
			workerHTTPFail(t, "incorrect foreign-owner detail query")
		}
		return model.WorkerSnapshot{}, model.ErrNotFound
	}}, func() { assertProjectError(t, f.send(http.MethodGet, path, ""), http.StatusNotFound, "not_found") })
	if calls != 1 {
		t.Fatalf("foreign detail calls: %d", calls)
	}
	foreignPage := f.list(t, "/api/v1/me/workers", store.Page{Limit: 50}, nil)
	if len(foreignPage.Items) != 0 {
		t.Fatal("other account worker leaked")
	}
	actor = nil
	assertProjectError(t, f.send(http.MethodGet, path, ""), http.StatusUnauthorized, "unauthenticated")
	pat := alice
	pat.Kind = model.PATCredential
	pat.CredentialID = uuid.NewString()
	actor = &pat
	f.handler.principal = pat
	f.report(t, id, body, nil, nil, snapshot)
	projectID, taskID, claimID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	claim := map[string]any{"claimId": claimID, "state": "active", "userId": alice.UserID, "workerId": id, "machine": map[string]any{"id": uuid.NewString(), "name": "Worker"}, "platform": "linux", "agent": "codex", "agentControlMode": "web", "worktreeId": uuid.NewString(), "phase": "preparing", "herdr": nil, "nativeSessionId": nil, "claimedAt": f.now.Format(time.RFC3339Nano)}
	task := model.Task{ID: taskID, ProjectID: projectID, Title: "Hidden after revoke", Status: model.TaskInProgress, Properties: model.TaskProperties{"worker": json.RawMessage(jsonBody(t, claim))}}
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": projectID, "taskId": taskID, "claimId": claimID}}}
	items := []model.WorkerObservedTask{{ProjectID: projectID, TaskID: taskID, ClaimID: claimID, Title: task.Title, ProjectName: "Private project", Status: model.TaskInProgress, Phase: model.WorkerPreparing, Agent: model.AgentCodex}}
	active := model.WorkerSnapshot{UserID: alice.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: workerInventoryTime(), Items: items}}
	actor = &alice
	origin = configuredTestConfig().PublicOrigin
	f.handler.principal = alice
	f.report(t, id, body, []store.WorkerTaskSource{{Task: task, ProjectName: "Private project"}}, items, active)
	detail := f.detail(t, id, active)
	if len(detail.Worker.Tasks) != 1 || detail.Worker.ActiveTaskCount == nil || *detail.Worker.ActiveTaskCount != 1 {
		t.Fatal("current member task missing")
	}
	revoked := active
	revoked.TaskSnapshot.Items = []model.WorkerObservedTask{}
	filtered := f.detail(t, id, revoked)
	encoded, err := json.Marshal(filtered)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Worker.Tasks) != 0 || filtered.Worker.ActiveTaskCount == nil || *filtered.Worker.ActiveTaskCount != 0 || strings.Contains(string(encoded), task.Title) {
		t.Fatal("revoked task row, title or count leaked")
	}
	count := 0
	page := f.list(t, "/api/v1/me/workers", store.Page{Limit: 50}, []store.WorkerSummary{{WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Machine: revoked.Telemetry.Machine, Platform: model.PlatformLinux, TaskObservationState: model.WorkerTasksObserved, TaskObservedAt: &f.now, ActiveTaskCount: &count}})
	if len(page.Items) != 1 || page.Items[0].ActiveTaskCount == nil || *page.Items[0].ActiveTaskCount != 0 {
		t.Fatal("revoked task count leaked through worker summary")
	}
	if strings.Contains(logs.String(), httpTestToken(model.PATCredential)) || strings.Contains(logs.String(), "Private worker machine") || strings.Contains(logs.String(), "/private/work") || strings.Contains(logs.String(), task.Title) {
		t.Fatal("report metadata or credentials leaked to logs")
	}
}
