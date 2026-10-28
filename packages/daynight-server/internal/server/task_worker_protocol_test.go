package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// New worker-mode fixtures opt in without changing legacy request helpers.
func extendedWorkerTestHandler(handler *resourceTestHandler) {
	original := handler.Handler
	handler.Handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		request.Header.Set("Daynight-Worker-Protocol", "2")
		original.ServeHTTP(w, request)
	})
}

func protocolRequest(handler http.Handler, method, path, body, protocol string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	if protocol != "" {
		request.Header.Set("Daynight-Worker-Protocol", protocol)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestWorkerProtocolLegacyAndExtendedResponses(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Legacy worker"), map[string]any{"allowAgents": true})
	response := protocolRequest(handler, "POST", taskPath(task)+"/worker-claim", jsonBody(t, workerClaimBody(task.Version)), "")
	claimed := decodeResponse[api.Task](t, response, http.StatusOK)
	if strings.Contains(response.Body.String(), "agentControlMode") {
		t.Fatal("legacy claim received a field rejected by the old strict parser")
	}
	if claimed.Properties.Worker == nil {
		t.Fatal("legacy Herdr claim disappeared")
	}
	for _, protocol := range []string{"", "1", "unexpected"} {
		response = protocolRequest(handler, "GET", taskPath(claimed), "", protocol)
		decodeResponse[api.Task](t, response, http.StatusOK)
		if strings.Contains(response.Body.String(), "agentControlMode") {
			t.Fatal("unnegotiated read received extended schema")
		}
	}
	response = protocolRequest(handler, "GET", taskPath(claimed), "", "2")
	assertHTTPWorkerMode(t, decodeResponse[api.Task](t, response, http.StatusOK), "herdr")
}

func TestWorkerProtocolLegacyReadsRemainAvailableWithoutControllingExtendedClaims(t *testing.T) {
	for _, configuration := range []struct{ provider, mode string }{{"codex", "web"}, {"claude", "web"}, {"claude", "herdr"}} {
		t.Run(configuration.provider+"-"+configuration.mode, func(t *testing.T) {
			handler := projectTestHandler(t, projectTestStore(t), io.Discard)
			project := taskProject(t, handler)
			task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Extended worker"), map[string]any{"allowAgents": true})
			body := workerClaimBody(task.Version)
			body["agent"], body["agentControlMode"] = configuration.provider, configuration.mode
			assertProjectError(t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim", jsonBody(t, body), ""), http.StatusConflict, "invalid_transition")
			unchanged := decodeResponse[api.Task](t, protocolRequest(handler, "GET", taskPath(task), "", "2"), http.StatusOK)
			if unchanged.Version != task.Version || unchanged.Properties.Worker != nil {
				t.Fatal("unnegotiated extended launch mutated task")
			}
			task = decodeResponse[api.Task](t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim", jsonBody(t, body), "2"), http.StatusOK)
			claim := task.Properties.Worker
			legacy := decodeResponse[api.Task](t, protocolRequest(handler, "GET", taskPath(task), "", ""), http.StatusOK)
			if legacy.Properties.Worker != nil || legacy.Status != "in_progress" || legacy.Ready || legacy.Version != task.Version {
				t.Fatal("legacy projection changed task lifecycle or exposed unsupported worker")
			}
			page := decodeResponse[api.TaskPage](t, protocolRequest(handler, "GET", "/api/v1/projects/"+project.ID+"/tasks", "", ""), http.StatusOK)
			if len(page.Items) != 1 || page.Items[0].Properties.Worker != nil {
				t.Fatal("ordinary legacy list did not preserve task")
			}
			assertProjectError(t, protocolRequest(handler, "GET", "/api/v1/projects/"+project.ID+"/tasks?workerId="+claim.WorkerID, "", ""), http.StatusConflict, "invalid_transition")
			operations := []struct {
				method, suffix string
				body           map[string]any
			}{
				{"PATCH", "/worker-claim", map[string]any{"claimId": claim.ClaimID, "phase": "waiting"}},
				{"POST", "/worker-claim/release", map[string]any{"claimId": claim.ClaimID, "stoppedConfirmed": true}},
				{"POST", "/worker-claim/withdraw", map[string]any{"claimId": claim.ClaimID}},
				{"PUT", "/status", map[string]any{"claimId": claim.ClaimID, "status": "done"}},
				{"PATCH", "", map[string]any{"title": "Unconfirmed"}},
				{"DELETE", "", map[string]any{}},
			}
			for _, op := range operations {
				op.body["version"] = task.Version
				assertProjectError(t, protocolRequest(handler, op.method, taskPath(task)+op.suffix, jsonBody(t, op.body), ""), http.StatusConflict, "invalid_transition")
			}
			read := decodeResponse[api.Task](t, protocolRequest(handler, "GET", taskPath(task), "", "2"), http.StatusOK)
			if read.Version != task.Version || read.Properties.Worker.ClaimID != claim.ClaimID || read.Title != task.Title {
				t.Fatal("legacy write changed extended claim")
			}
			task = decodeResponse[api.Task](t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": claim.ClaimID, "stoppedConfirmed": true}), "2"), http.StatusOK)
			fresh := workerClaimBody(task.Version)
			assertProjectError(t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim", jsonBody(t, fresh), ""), http.StatusConflict, "invalid_transition")
			fresh["previousClaimId"] = claim.ClaimID
			assertProjectError(t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim/resume", jsonBody(t, fresh), ""), http.StatusConflict, "invalid_transition")
			read = decodeResponse[api.Task](t, protocolRequest(handler, "GET", taskPath(task), "", "2"), http.StatusOK)
			if read.Version != task.Version || read.Properties.Worker.ClaimID != claim.ClaimID {
				t.Fatal("legacy reclaim replaced extended claim")
			}
			fresh["agent"], fresh["agentControlMode"] = configuration.provider, configuration.mode
			task = decodeResponse[api.Task](t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim/resume", jsonBody(t, fresh), "2"), http.StatusOK)
			task = decodeResponse[api.Task](t, protocolRequest(handler, "PUT", taskPath(task)+"/status", jsonBody(t, map[string]any{"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "status": "done"}), "2"), http.StatusOK)
			legacy = decodeResponse[api.Task](t, protocolRequest(handler, "GET", taskPath(task), "", ""), http.StatusOK)
			if legacy.Properties.Worker != nil || legacy.Status != "done" || legacy.Version != task.Version {
				t.Fatal("completed extended history is not readable")
			}
			assertProjectError(t, protocolRequest(handler, "PUT", taskPath(task)+"/status", jsonBody(t, map[string]any{"version": task.Version, "status": "todo"}), ""), http.StatusConflict, "invalid_transition")
		})
	}
}

func TestWorkerProtocolLegacyCandidatesAdvanceAcrossUnsupportedPages(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	makeTask := func(extended bool) api.Task {
		task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Candidate"), map[string]any{"allowAgents": true})
		if !extended {
			return task
		}
		body := workerClaimBody(task.Version)
		body["agentControlMode"] = "web"
		task = decodeResponse[api.Task](t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim", jsonBody(t, body), "2"), http.StatusOK)
		return decodeResponse[api.Task](t, protocolRequest(handler, "POST", taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "stoppedConfirmed": true}), "2"), http.StatusOK)
	}
	for range 3 {
		makeTask(true)
	}
	path := "/api/v1/projects/" + project.ID + "/tasks?ready=true&allowAgents=true&compatiblePlatform=linux"
	empty := decodeResponse[api.TaskPage](t, protocolRequest(handler, "GET", path+"&limit=1", "", ""), http.StatusOK)
	if len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatal("unsupported-only candidates did not exhaust")
	}
	first := makeTask(false)
	makeTask(true)
	second := makeTask(false)
	for _, limit := range []string{"1", "3"} {
		var ids []string
		next := path + "&limit=" + limit
		seen := map[string]bool{}
		for {
			page := decodeResponse[api.TaskPage](t, protocolRequest(handler, "GET", next, "", ""), http.StatusOK)
			for _, task := range page.Items {
				ids = append(ids, task.ID)
			}
			if page.NextCursor == nil {
				break
			}
			if len(page.Items) == 0 || seen[*page.NextCursor] {
				t.Fatal("filtered pagination did not advance")
			}
			seen[*page.NextCursor] = true
			next = path + "&limit=" + limit + "&cursor=" + *page.NextCursor
		}
		if len(ids) != 2 || ids[0] != first.ID || ids[1] != second.ID {
			t.Fatalf("compatible candidates = %v", ids)
		}
	}
	ordinary := decodeResponse[api.TaskPage](t, protocolRequest(handler, "GET", "/api/v1/projects/"+project.ID+"/tasks?ready=true&allowAgents=true", "", ""), http.StatusOK)
	if len(ordinary.Items) != 6 {
		t.Fatal("ordinary list hid unsupported tasks")
	}
	extended := decodeResponse[api.TaskPage](t, protocolRequest(handler, "GET", path, "", "2"), http.StatusOK)
	if len(extended.Items) != 6 {
		t.Fatal("extended discovery hid supported tasks")
	}
}
