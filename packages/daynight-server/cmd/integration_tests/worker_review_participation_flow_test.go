//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"
)

func serverAPIWorkerReviewParticipationFlow(t *testing.T, f *fixture, workerID string, report, configuration map[string]any, headers, reportHeaders http.Header) {
	t.Helper()
	base := "/api/v1/me/workers/" + workerID
	type participation struct {
		Enabled bool   `json:"enabled"`
		Version string `json:"version"`
	}
	read := func() participation {
		t.Helper()
		return requestJSON[participation](t, f, http.MethodGet, base+"/review-participation", nil, http.StatusOK)
	}
	put := func(enabled bool, version string) participation {
		t.Helper()
		return requestJSON[participation](t, f, http.MethodPut, base+"/review-participation", map[string]any{"enabled": enabled, "expectedVersion": version}, http.StatusOK)
	}
	initial := read()
	if initial.Enabled || initial.Version != "1" {
		t.Fatalf("new Worker review participation: %+v", initial)
	}
	before := requestJSON[map[string]any](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, headers)
	type detail struct {
		Worker struct {
			LastReportedAt time.Time `json:"lastReportedAt"`
		} `json:"worker"`
	}
	workerBefore := requestJSON[detail](t, f, http.MethodGet, base, nil, http.StatusOK, headers)
	saved := put(true, initial.Version)
	if !saved.Enabled || saved.Version != "2" || read() != saved {
		t.Fatalf("enabled review participation: %+v", saved)
	}
	after := requestJSON[map[string]any](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, headers)
	workerAfter := requestJSON[detail](t, f, http.MethodGet, base, nil, http.StatusOK, headers)
	if !reflect.DeepEqual(before, after) || workerBefore.Worker.LastReportedAt.IsZero() || !workerBefore.Worker.LastReportedAt.Equal(workerAfter.Worker.LastReportedAt) {
		t.Fatalf("review participation changed configuration or online time: before=%+v after=%+v workerBefore=%+v workerAfter=%+v", before, after, workerBefore, workerAfter)
	}
	requestJSON[json.RawMessage](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	if got := read(); got != saved {
		t.Fatalf("Worker report replaced review participation: %+v", got)
	}
	current := requestJSON[struct {
		Desired struct {
			Revision string `json:"revision"`
		} `json:"desired"`
	}](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, headers)
	configuration["maxConcurrent"] = 2
	requestJSON[json.RawMessage](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": current.Desired.Revision, "value": configuration}, http.StatusOK, headers)
	if got := read(); got != saved {
		t.Fatalf("configuration write replaced review participation: %+v", got)
	}
	cleared := put(false, saved.Version)
	if cleared.Enabled || cleared.Version != "3" || read() != cleared {
		t.Fatalf("disabled review participation: %+v", cleared)
	}
}
