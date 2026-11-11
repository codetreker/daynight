package worker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	monitorredis "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
	redisclient "github.com/redis/go-redis/v9"
)

type flowReader struct {
	store.WorkerReader
	workerID, projectID, taskID string
}

func (r flowReader) MonitoringWorkers(_ context.Context, _ string, ids []string, _ time.Time) ([]string, error) {
	if len(ids) != 1 || ids[0] != r.workerID {
		return nil, nil
	}
	return ids, nil
}
func (r flowReader) MonitoringSources(_ context.Context, _ string, _, _ []string) (store.WorkerMonitoringSources, error) {
	return store.WorkerMonitoringSources{Projects: map[string]string{r.projectID: "Project"}, Tasks: map[string]store.WorkerTaskSource{r.taskID: {Task: model.Task{ID: r.taskID, ProjectID: r.projectID, Title: "Task"}, ProjectName: "Project"}}}, nil
}

type flowSnapshot struct {
	store.SnapshotScope
	reader flowReader
}

func (s flowSnapshot) WorkerDAO() store.WorkerReader                 { return s.reader }
func (s flowSnapshot) ObservedAt(context.Context) (time.Time, error) { return time.Now().UTC(), nil }

type flowDB struct {
	store.WorkerWriter
	reader flowReader
}

func (d flowDB) ReadSnapshot(_ context.Context, f func(store.SnapshotScope) error) error {
	return f(flowSnapshot{reader: d.reader})
}

func TestMonitoringHTTPRedisServiceFlow(t *testing.T) {
	rawURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if rawURL == "" {
		t.Fatal("DAYNIGHT_TEST_REDIS_URL is required")
	}
	backend, err := monitorredis.New(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	options, err := redisclient.ParseURL(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	client := redisclient.NewClient(options)
	user, worker, project, task, claim := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := client.Del(ctx, "dn:worker-monitoring:{"+user+":"+worker+"}").Err(); err != nil {
			t.Error(err)
		}
		if err := client.Close(); err != nil {
			t.Error(err)
		}
		if err := backend.Close(); err != nil {
			t.Error(err)
		}
	})
	service := workerservice.NewWorkers(flowDB{reader: flowReader{workerID: worker, projectID: project, taskID: task}})
	service.SetMonitoringStore(backend)
	mux := http.NewServeMux()
	registerRoutes(mux, &workersHandler{workers: service, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, func(next httpx.AuthenticatedHandler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			next(w, r, model.Principal{UserID: user, CredentialID: claim, Kind: model.PATCredential})
		}
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	failure := map[string]any{"operationId": claim, "component": "cleanup", "phase": "archive", "scope": map[string]any{"kind": "claim", "projectId": project, "taskId": task, "claimId": claim}, "error": map[string]any{"type": "operation", "code": "unknown", "cause": "The operation failed; inspect local Worker diagnostics for details.", "causeTruncated": false}, "firstObservedAt": "2026-10-29T00:00:00Z", "lastObservedAt": "2026-10-29T00:00:00Z", "occurrencesInRun": 1, "retryState": "none", "nextAttemptAt": nil, "worktree": map[string]any{"kind": "project-relative", "path": "../tree/<>&"}}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(monitoringBody), &envelope); err != nil {
		t.Fatal(err)
	}
	envelope["observation"].(map[string]any)["currentFailures"] = []any{failure}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPut, server.URL+"/api/v1/me/workers/"+worker+"/monitoring", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	clientHTTP := &http.Client{Timeout: 5 * time.Second}
	response, err := clientHTTP.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("PUT: %d", response.StatusCode)
	}
	request, err = http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/api/v1/me/workers/"+worker+"/monitoring", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = clientHTTP.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Data struct {
			CurrentFailures []struct {
				Worktree    struct{ Kind, Path string }
				Association struct{ Kind, ProjectName, Title string }
			} `json:"currentFailures"`
		} `json:"data"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&result) != nil || len(result.Data.CurrentFailures) != 1 {
		t.Fatalf("GET: status=%d result=%+v", response.StatusCode, result)
	}
	got := result.Data.CurrentFailures[0]
	if got.Worktree.Kind != "project-relative" || got.Worktree.Path != "../tree/<>&" || got.Association.Kind != "task" || got.Association.ProjectName != "Project" || got.Association.Title != "Task" {
		t.Fatalf("projected detail: %+v", got)
	}
}
