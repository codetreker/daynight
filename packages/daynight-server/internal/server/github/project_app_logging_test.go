package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const projectAppConnectBody = `{"version":"3","ownershipVersion":"8","appResourceId":"` + appID + `","appVersion":"2","grantId":"` + projectAppGrant + `","installationId":"99"}`

func projectAppLoggingHandler(ops projectAppOps, output io.Writer) http.Handler {
	logger := slog.New(slog.NewJSONHandler(output, nil))
	mux := http.NewServeMux()
	RegisterProjectAppRoutes(mux, ops, authStub{}, logger)
	return httpx.RequestLogging(logger, mux)
}

func projectAppLoggingRequest(method, suffix, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/v1/projects/"+strings.ToUpper(projectID)+"/github"+suffix, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Request-ID", "project-app-request")
	return r
}

func projectAppLogRecords(t *testing.T, data []byte) []map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var records []map[string]any
	for {
		var record map[string]any
		err := decoder.Decode(&record)
		if errors.Is(err, io.EOF) {
			return records
		}
		if err != nil {
			t.Fatal(err)
		}
		if record["component"] == "github" {
			records = append(records, record)
		}
	}
}

func TestProjectAppHTTPMutationLogsRetainCorrelation(t *testing.T) {
	for _, operation := range []string{"connect", "disconnect", "settings", "sync"} {
		t.Run(operation, func(t *testing.T) {
			var logs bytes.Buffer
			calls := 0
			result := projectAppFixture()
			result.Connection.Version, result.Connection.Generation = 4, 9
			complete := func(ctx context.Context) (core.ProjectAppStatus, error) {
				calls++
				if httpx.RequestID(ctx) != "project-app-request" {
					t.Fatal("request identity lost before operation")
				}
				return result, nil
			}
			ops := projectAppOps{t: t}
			method, body, phase := "POST", projectAppConnectBody, operation
			switch operation {
			case "connect":
				ops.connect = func(ctx context.Context, _ model.Principal, _ string, _ core.ProjectAppConnect) (core.ProjectAppStatus, error) {
					return complete(ctx)
				}
			case "disconnect":
				body = `{"version":"3","ownershipVersion":"8"}`
				ops.disconnect = func(ctx context.Context, _ model.Principal, _ string, _ core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
					return complete(ctx)
				}
			case "settings":
				method, body = "PATCH", `{"version":"3","pollIntervalMinutes":2}`
				ops.settings = func(ctx context.Context, _ model.Principal, _ string, _ int64, _ int32) (core.ProjectAppStatus, error) {
					return complete(ctx)
				}
			case "sync":
				method, body, phase = "PATCH", `{"version":"3","syncEnabled":true}`, "sync_config"
				ops.sync = func(ctx context.Context, _ model.Principal, _ string, _ int64, _ bool) (core.ProjectAppStatus, error) {
					return complete(ctx)
				}
			}
			w := httptest.NewRecorder()
			projectAppLoggingHandler(ops, &logs).ServeHTTP(w, projectAppLoggingRequest(method, "/"+operation, body))
			records := projectAppLogRecords(t, logs.Bytes())
			if calls != 1 || w.Code != http.StatusOK || len(records) != 1 {
				t.Fatalf("calls=%d status=%d logs=%s", calls, w.Code, &logs)
			}
			want := map[string]any{"component": "github", "phase": "response", "operation_phase": phase, "request_id": "project-app-request",
				"user_id": userID, "project_id": projectID, "app_resource_id": appID, "app_id": json.Number("9007199254740993"),
				"grant_id": projectAppGrant, "version": json.Number("4"), "generation": json.Number("9"), "expected_version": json.Number("3")}
			if operation == "connect" {
				want["requested_app_resource_id"], want["requested_grant_id"] = appID, projectAppGrant
				want["expected_app_version"] = json.Number("2")
			}
			if operation == "connect" || operation == "disconnect" {
				want["expected_ownership_version"] = json.Number("8")
			}
			for key, value := range want {
				if records[0][key] != value {
					t.Errorf("%s=%v want %v", key, records[0][key], value)
				}
			}
			if _, present := records[0]["write_outcome"]; present {
				t.Fatal("HTTP success invented a database outcome")
			}
		})
	}
}

func TestProjectAppHTTPFailureLogsKeepSubmittedConditionsAndRedactCauses(t *testing.T) {
	const private = "PRIVATE-KEY WEBHOOK-SECRET INVITATION-TOKEN remote-private-project-body"
	for _, failure := range []error{
		&model.Fault{Code: "forbidden", Message: "Owner Team administrator permission is required.", Cause: errors.New(private)},
		errors.New(private),
	} {
		var logs bytes.Buffer
		calls := 0
		ops := projectAppOps{t: t, connect: func(context.Context, model.Principal, string, core.ProjectAppConnect) (core.ProjectAppStatus, error) {
			calls++
			return core.ProjectAppStatus{}, failure
		}}
		w := httptest.NewRecorder()
		projectAppLoggingHandler(ops, &logs).ServeHTTP(w, projectAppLoggingRequest("POST", "/connect", projectAppConnectBody))
		records := projectAppLogRecords(t, logs.Bytes())
		if calls != 1 || len(records) != 1 {
			t.Fatalf("calls=%d body=%s logs=%s", calls, w.Body, &logs)
		}
		for _, secret := range strings.Fields(private) {
			if strings.Contains(logs.String()+w.Body.String(), secret) {
				t.Fatalf("private cause %q escaped", secret)
			}
		}
		for key, value := range map[string]any{"request_id": "project-app-request", "user_id": userID, "project_id": projectID, "phase": "connect",
			"operation_phase": "connect", "requested_app_resource_id": appID, "requested_grant_id": projectAppGrant, "expected_version": json.Number("3")} {
			if records[0][key] != value {
				t.Errorf("%s=%v want %v", key, records[0][key], value)
			}
		}
		for _, key := range []string{"app_resource_id", "app_id", "grant_id", "generation", "version", "team_id", "write_outcome"} {
			if _, present := records[0][key]; present {
				t.Errorf("unverified current fact %s in %s", key, &logs)
			}
		}
	}
}

func TestProjectAppHTTPResponseFailuresDoNotReplayOrClaimDatabaseOutcome(t *testing.T) {
	for _, mode := range []string{"short-write", "marshal", "projection", "cancel-after-operation"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			calls := 0
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ops := projectAppOps{t: t, connect: func(context.Context, model.Principal, string, core.ProjectAppConnect) (core.ProjectAppStatus, error) {
				calls++
				out := projectAppFixture()
				out.Connection.Version, out.Connection.Generation = 4, 9
				switch mode {
				case "marshal":
					out.Connection.LastPollAttemptAt = pointer(time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC))
				case "projection":
					out.Connection.RepositoryID = pointer(int64(99))
				case "cancel-after-operation":
					cancel()
				}
				return out, nil
			}}
			recorder := httptest.NewRecorder()
			var w http.ResponseWriter = recorder
			if mode == "short-write" {
				w = &appShortWriter{header: make(http.Header)}
			}
			projectAppLoggingHandler(ops, &logs).ServeHTTP(w, projectAppLoggingRequest("POST", "/connect", projectAppConnectBody).WithContext(ctx))
			records := projectAppLogRecords(t, logs.Bytes())
			if calls != 1 || len(records) != 1 {
				t.Fatalf("calls=%d logs=%s", calls, &logs)
			}
			record := records[0]
			if record["request_id"] != "project-app-request" || record["operation_phase"] != "connect" || record["app_resource_id"] != appID || record["generation"] != json.Number("9") {
				t.Fatalf("lost completed-operation correlation: %s", &logs)
			}
			if mode == "projection" {
				if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), `"writeOutcome":"unknown"`) {
					t.Fatalf("projection failure: %d %s", recorder.Code, recorder.Body)
				}
			} else if record["phase"] != "response" || record["write_outcome"] != "unknown" {
				t.Fatalf("response delivery outcome: %s", &logs)
			}
			if mode == "cancel-after-operation" && recorder.Body.Len() != 0 {
				t.Fatalf("canceled response: %s", recorder.Body)
			}
		})
	}
}

func TestProjectAppHTTPBodyRejectionAndCancellationKeepRequestIdentity(t *testing.T) {
	for _, mode := range []string{"body-rejection", "canceled-operation"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			calls := 0
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ops := projectAppOps{t: t, connect: func(work context.Context, _ model.Principal, _ string, _ core.ProjectAppConnect) (core.ProjectAppStatus, error) {
				calls++
				cancel()
				if !errors.Is(work.Err(), context.Canceled) {
					t.Fatal("operation context was not canceled")
				}
				return core.ProjectAppStatus{}, work.Err()
			}}
			body := projectAppConnectBody
			if mode == "body-rejection" {
				body = strings.Repeat(" ", appWriteBytes+1)
			}
			w := httptest.NewRecorder()
			projectAppLoggingHandler(ops, &logs).ServeHTTP(w, projectAppLoggingRequest("POST", "/connect", body).WithContext(ctx))
			records := projectAppLogRecords(t, logs.Bytes())
			if len(records) != 1 {
				t.Fatalf("logs=%s", &logs)
			}
			for key, value := range map[string]any{"request_id": "project-app-request", "user_id": userID, "project_id": projectID, "operation_phase": "connect", "phase": "connect"} {
				if records[0][key] != value {
					t.Errorf("%s=%v want %v", key, records[0][key], value)
				}
			}
			if mode == "body-rejection" && (calls != 0 || w.Code != http.StatusRequestEntityTooLarge) {
				t.Fatalf("body rejection calls=%d status=%d", calls, w.Code)
			}
			if mode == "canceled-operation" && (calls != 1 || w.Body.Len() != 0) {
				t.Fatalf("canceled operation calls=%d body=%s", calls, w.Body)
			}
			if _, present := records[0]["write_outcome"]; present {
				t.Fatal("HTTP request failure invented a database outcome")
			}
		})
	}
}
