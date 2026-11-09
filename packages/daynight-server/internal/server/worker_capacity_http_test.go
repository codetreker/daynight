package server

import (
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/google/uuid"
)

func boundedUTF8(size int) string { return strings.Repeat("界", size/3) + strings.Repeat("x", size%3) }

func TestWorkerReportCapacityHTTPRejectsBeforeWrite(t *testing.T) {
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
			f := newCapacityReportOperationFixture(t, uuid.NewString())
			body := workerSnapshotReportBody()
			value := boundedUTF8(tc.size)
			tc.set(body, value)
			f.success(body)
			tc.set(body, value+"x")
			assertProjectError(t, f.request(body, 1, &model.Fault{Code: "invalid_input", Message: "Worker report exceeds its capacity."}), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, kind := range []string{"claims", "projects"} {
		t.Run(kind, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, uuid.NewString())
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
			f.success(body)
			set(maximum + 1)
			assertProjectError(t, f.request(body, 0, nil), http.StatusBadRequest, "invalid_input")
		})
	}
}

func TestWorkerConfigurationCapacityHTTPRejectsBeforeWrite(t *testing.T) {
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
	cases = append(cases, struct {
		name           string
		valid, invalid any
		set            func(map[string]any, any)
	}{"native.args", args, append(append([]any{}, args...), "x"), func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x }})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityHTTPFixture(t, uuid.NewString(), io.Discard)
			path := "/api/v1/me/workers/" + f.worker + "/configuration"
			current := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Value: capacityDecode[model.WorkerConfiguration](t, configurationHTTPValue()), UpdatedAt: capacityObservedAt}, ObservationRevision: "0"}
			value := configurationHTTPValue()
			tc.set(value, tc.valid)
			want := capacityDecode[model.WorkerConfiguration](t, value)
			changed := !reflect.DeepEqual(current.Desired.Value, want)
			saved := current
			if changed {
				saved.Desired = &model.WorkerDesiredConfiguration{Revision: "2", Value: want, UpdatedAt: capacityObservedAt.Add(1)}
			}
			calls := []string{"dao", "configuration"}
			if changed {
				calls = append(calls, "set_configuration")
			}
			plan := f.write(calls, store.TransactionCommitted, func(d *capacityWorkerDAO) {
				d.configuration = func(user, worker string) (model.WorkerConfigurationResource, error) {
					f.workerAddress(user, worker)
					return capacityDecode[model.WorkerConfigurationResource](t, current), nil
				}
				d.setConfiguration = func(user, worker string, revision int64, actual model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
					f.workerAddress(user, worker)
					if revision != 2 || !reflect.DeepEqual(actual, want) {
						t.Fatal("configuration boundary write differs")
					}
					return capacityDecode[model.WorkerDesiredConfiguration](t, *saved.Desired), nil
				}
			})
			got := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(f.handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), http.StatusOK)
			plan.check()
			if !reflect.DeepEqual(got, saved) {
				t.Fatalf("configuration boundary response differs: %+v", got)
			}
			f.rejectBeforeWrite()
			tc.set(value, tc.invalid)
			assertProjectError(t, projectRequest(f.handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": saved.Desired.Revision, "value": value})), 400, "invalid_input")
		})
	}
	t.Run("desired.projects", func(t *testing.T) {
		f := newCapacityHTTPFixture(t, uuid.NewString(), io.Discard)
		path := "/api/v1/me/workers/" + f.worker + "/configuration"
		value := configurationHTTPValue()
		projects := make([]any, 129)
		for i := range projects {
			projects[i] = map[string]any{"projectId": fmt.Sprintf("%08x-0000-4000-8000-000000000001", i+1), "nativeOverrides": map[string]any{}}
		}
		value["projects"] = projects[:128]
		current := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Value: capacityDecode[model.WorkerConfiguration](t, value), UpdatedAt: capacityObservedAt}, ObservationRevision: "0"}
		plan := f.write([]string{"dao", "configuration"}, store.TransactionCommitted, func(d *capacityWorkerDAO) {
			d.configuration = func(user, worker string) (model.WorkerConfigurationResource, error) {
				f.workerAddress(user, worker)
				return capacityDecode[model.WorkerConfigurationResource](t, current), nil
			}
		})
		got := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(f.handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), http.StatusOK)
		plan.check()
		if !reflect.DeepEqual(got, current) {
			t.Fatal("equal configuration changed revision or content")
		}
		f.rejectBeforeWrite()
		value["projects"] = projects
		assertProjectError(t, projectRequest(f.handler, http.MethodPut, path, jsonBody(t, map[string]any{"revision": "1", "value": value})), 400, "invalid_input")
	})
	t.Run("observation.items", func(t *testing.T) {
		f := newCapacityHTTPFixture(t, uuid.NewString(), io.Discard)
		items := make([]any, coreworker.MaxObservationItems+1)
		for i := range items {
			items[i] = map[string]any{"key": map[string]any{"kind": "projectPreparation", "projectId": uuid.NewString()}, "targetRevision": "1", "appliedValue": nil, "state": "pending", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
		}
		obs := map[string]any{"baseRevision": "0", "desiredRevision": "1", "items": items[:coreworker.MaxObservationItems]}
		body := configurationHTTPReportBody(nil, obs)
		stored := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)
		current := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Value: capacityDecode[model.WorkerConfiguration](t, configurationHTTPValue()), UpdatedAt: capacityObservedAt}, ObservationRevision: "0"}
		reported := model.WorkerConfigurationResource{Desired: current.Desired, ObservationRevision: "1", Observation: &model.WorkerConfigurationReportedObservation{ReportedAt: capacityObservedAt, WorkerConfigurationObservation: capacityDecode[model.WorkerConfigurationObservation](t, obs)}}
		reads := 0
		plan := f.write([]string{"dao", "admit", "upsert", "configuration", "set_observation", "configuration", "observed"}, store.TransactionCommitted, func(d *capacityWorkerDAO) {
			f.reportDAO(d, body, stored)
			d.configuration = func(user, worker string) (model.WorkerConfigurationResource, error) {
				f.workerAddress(user, worker)
				reads++
				if reads == 1 {
					return capacityDecode[model.WorkerConfigurationResource](t, current), nil
				}
				return capacityDecode[model.WorkerConfigurationResource](t, reported), nil
			}
			d.setObservation = func(user, worker string, revision int64, actual model.WorkerConfigurationObservation) error {
				f.workerAddress(user, worker)
				if revision != 1 || !reflect.DeepEqual(actual, reported.Observation.WorkerConfigurationObservation) {
					t.Fatal("observation boundary differs")
				}
				return nil
			}
		})
		response := configurationHTTPRequest(f.handler, http.MethodPost, "/api/v1/me/workers/"+f.worker+"/report", jsonBody(t, body), "1")
		if response.Header().Get(workerConfigurationHeader) != "1" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
			t.Fatal("configuration report lacks its protocol or private response headers")
		}
		receipt := decodeResponse[configurationHTTPReceipt](t, response, http.StatusOK)
		plan.check()
		if !receipt.Configuration.ObservationAccepted || receipt.Configuration.ObservationRevision != "1" || !reflect.DeepEqual(receipt.Configuration.Desired, current.Desired) {
			t.Fatal("maximum item observation receipt differs")
		}
		f.rejectBeforeWrite()
		obs["baseRevision"] = "1"
		obs["items"] = items
		assertProjectError(t, configurationHTTPRequest(f.handler, http.MethodPost, "/api/v1/me/workers/"+f.worker+"/report", jsonBody(t, configurationHTTPReportBody(nil, obs)), "1"), 400, "invalid_input")
	})
}
