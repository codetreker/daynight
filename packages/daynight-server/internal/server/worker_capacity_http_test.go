package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func boundedUTF8(size int) string { return strings.Repeat("界", size/3) + strings.Repeat("x", size%3) }

func TestWorkerReportCapacityHTTPLeavesStoredStateUnchanged(t *testing.T) {
	db := projectTestStore(t)
	handler := projectTestHandler(t, db, io.Discard)
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id + "/report"
	tests := []struct {
		name string
		size int
		set  func(map[string]any, string)
	}{
		{"machine", 256, func(b map[string]any, s string) { b["machine"].(map[string]any)["name"] = s }},
		{"cwd", 4096, func(b map[string]any, s string) { b["workingDirectory"] = s }},
		{"daynight", 256, func(b map[string]any, s string) { b["versions"].(map[string]any)["daynight"] = s }},
		{"herdr", 256, func(b map[string]any, s string) {
			b["versions"].(map[string]any)["herdr"].(map[string]any)["value"] = s
		}},
		{"codex", 256, func(b map[string]any, s string) {
			b["versions"].(map[string]any)["codex"] = map[string]any{"state": "ok", "checkedAt": "2026-10-29T00:00:00Z", "value": s}
		}},
		{"copilot", 256, func(b map[string]any, s string) {
			b["versions"].(map[string]any)["copilot"] = map[string]any{"state": "ok", "checkedAt": "2026-10-29T00:00:00Z", "value": s}
		}},
		{"os.type", 64, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["type"] = s }},
		{"os.arch", 64, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["arch"] = s }},
		{"os.release", 256, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["release"] = s }},
		{"os.version", 1024, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["version"] = s }},
		{"cpu.model", 512, func(b map[string]any, s string) { b["cpu"].(map[string]any)["value"].(map[string]any)["model"] = s }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body := workerSnapshotReportBody()
			value := boundedUTF8(tc.size)
			tc.set(body, value)
			reportSnapshotHTTP(t, handler, id, body)
			var before, after string
			query := "SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2"
			if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&before); err != nil {
				t.Fatal(err)
			}
			tc.set(body, value+"x")
			assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, body)), 400, "invalid_input")
			if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("rejected report changed persisted worker")
			}
		})
	}
	for _, kind := range []string{"claims", "projects"} {
		t.Run(kind, func(t *testing.T) {
			body := workerSnapshotReportBody()
			set := func(n int) {
				items := make([]any, n)
				for i := range items {
					if kind == "claims" {
						items[i] = map[string]any{"projectId": uuid.NewString(), "taskId": uuid.NewString(), "claimId": uuid.NewString()}
					} else {
						items[i] = map[string]any{"projectId": uuid.NewString(), "native": nil}
					}
				}
				if kind == "claims" {
					body["taskInventory"].(map[string]any)["claims"] = items
				} else {
					body["runtimeConfiguration"] = map[string]any{"schemaVersion": 1, "native": nil, "projects": items}
				}
			}
			maximum := 256
			if kind == "projects" {
				maximum = 128
			}
			set(maximum)
			reportSnapshotHTTP(t, handler, id, body)
			var before, after string
			query := "SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2"
			if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&before); err != nil {
				t.Fatal(err)
			}
			set(maximum + 1)
			assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, body)), 400, "invalid_input")
			if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal(fmt.Sprintf("%s rejection changed persisted worker", kind))
			}
		})
	}
}

func TestWorkerConfigurationCapacityHTTPLeavesStoredStateUnchanged(t *testing.T) {
	db := projectTestStore(t)
	handler := projectTestHandler(t, db, io.Discard)
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id + "/configuration"
	configurationHTTPReport(t, handler, id, configurationHTTPValue(), nil)
	query := "SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2"
	cases := []struct {
		name           string
		valid, invalid any
		set            func(map[string]any, any)
	}{
		{"maxConcurrent", 64, 65, func(v map[string]any, x any) { v["maxConcurrent"] = x }},
		{"pollIntervalMs", 60000, 60001, func(v map[string]any, x any) { v["pollIntervalMs"] = x }},
		{"recoveryLimit", 10, 11, func(v map[string]any, x any) { v["recoveryLimit"] = x }},
		{"native.model", boundedUTF8(256), boundedUTF8(256) + "x", func(v map[string]any, x any) { v["native"].(map[string]any)["model"] = x }},
		{"native.arg", []any{boundedUTF8(4096)}, []any{boundedUTF8(4096) + "x"}, func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x }},
	}
	args := make([]any, 128)
	for i := range args {
		args[i] = "x"
	}
	argsOver := append(append([]any{}, args...), "x")
	cases = append(cases, struct {
		name           string
		valid, invalid any
		set            func(map[string]any, any)
	}{"native.args", args, argsOver, func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x }})
	revision := "1"
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := configurationHTTPValue()
			tc.set(value, tc.valid)
			response := projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": revision, "value": value}))
			got := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
			revision = got.Desired.Revision
			var before, after string
			if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&before); err != nil {
				t.Fatal(err)
			}
			tc.set(value, tc.invalid)
			assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": revision, "value": value})), 400, "invalid_input")
			if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("rejected configuration changed persisted worker")
			}
		})
	}
	t.Run("desired.projects", func(t *testing.T) {
		value := configurationHTTPValue()
		projects := make([]any, 129)
		for i := range projects {
			projects[i] = map[string]any{"projectId": uuid.NewString(), "nativeOverrides": map[string]any{}}
		}
		value["projects"] = projects[:128]
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(context.Background(), "UPDATE workers SET desired_configuration=$3 WHERE user_id=$1 AND worker_id=$2", handler.principal.UserID, id, encoded); err != nil {
			t.Fatal(err)
		}
		response := projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": revision, "value": value}))
		got := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
		if got.Desired.Revision != revision {
			t.Fatal("equal configuration changed revision")
		}
		var before, after string
		if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&before); err != nil {
			t.Fatal(err)
		}
		value["projects"] = projects
		assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": revision, "value": value})), 400, "invalid_input")
		if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if before != after {
			t.Fatal("rejected projects changed persisted worker")
		}
	})
	t.Run("observation.items", func(t *testing.T) {
		items := make([]any, 1025)
		for i := range items {
			items[i] = map[string]any{"key": map[string]any{"kind": "projectPreparation", "projectId": uuid.NewString()}, "targetRevision": revision, "appliedValue": nil, "state": "pending", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
		}
		obs := map[string]any{"baseRevision": "0", "desiredRevision": revision, "items": items[:1024]}
		receipt := configurationHTTPReport(t, handler, id, nil, obs)
		if !receipt.Configuration.ObservationAccepted {
			t.Fatal("1024 item observation rejected")
		}
		var before, after string
		if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&before); err != nil {
			t.Fatal(err)
		}
		obs["baseRevision"] = "1"
		obs["items"] = items
		response := configurationHTTPRequest(handler, http.MethodPost, "/api/v1/me/workers/"+id+"/report", jsonBody(t, configurationHTTPReportBody(nil, obs)), "1")
		assertProjectError(t, response, 400, "invalid_input")
		if err := db.Pool.QueryRow(context.Background(), query, handler.principal.UserID, id).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if before != after {
			t.Fatal("rejected observation changed persisted worker")
		}
	})
}
