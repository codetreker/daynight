//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func serverAPIWorkerPlatformTaskModeFlow(t *testing.T, f *fixture) {
	base := "/api/v1/me/workers/" + uuid.NewString()
	legacyHeaders := http.Header{"Daynight-Worker-Tool-Paths": {"2"}, "Daynight-Worker-Archive-Sessions": {"1"}}
	headers := legacyHeaders.Clone()
	headers.Set("Daynight-Worker-Platform-Task-Mode", "1")
	reportHeaders := headers.Clone()
	reportHeaders.Set("Daynight-Worker-Configuration", "1")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	paths := map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": map[string]any{"kind": "auto"}}
	bootstrap := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3, "preferPlatformSpecificTasks": false, "archiveSessions": true, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": []any{}, "toolPaths": paths}
	report := map[string]any{
		"machine": map[string]any{"id": uuid.NewString(), "name": "Platform mode integration"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		"toolPaths":     map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}},
		"configuration": map[string]any{"bootstrap": bootstrap, "observation": nil, "toolPathsBootstrap": paths},
	}
	requestJSON[json.RawMessage](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	type resource struct {
		Desired struct {
			Revision string         `json:"revision"`
			Value    map[string]any `json:"value"`
		} `json:"desired"`
		ObservationRevision string `json:"observationRevision"`
		Observation         *struct {
			Items []struct {
				Key struct {
					Kind string `json:"kind"`
				} `json:"key"`
				AppliedValue any `json:"appliedValue"`
			} `json:"items"`
		} `json:"observation"`
	}
	read := func(view http.Header) resource {
		t.Helper()
		return requestJSON[resource](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, view)
	}
	initial := read(headers)
	if initial.Desired.Value["platformTaskMode"] != "all" || initial.Observation != nil {
		t.Fatalf("bootstrap mode or application differs: %+v", initial)
	}
	item := func(kind string, value any, revision string) any {
		return map[string]any{"key": map[string]any{"kind": kind}, "targetRevision": revision, "appliedValue": value, "state": "applied", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
	}
	observe := func(view http.Header, baseRevision, desiredRevision, kind string, value any) {
		t.Helper()
		report["configuration"] = map[string]any{"bootstrap": nil, "observation": map[string]any{"baseRevision": baseRevision, "desiredRevision": desiredRevision, "items": []any{item(kind, value, desiredRevision)}}, "toolPathsBootstrap": nil}
		requestJSON[json.RawMessage](t, f, http.MethodPost, base+"/report", report, http.StatusOK, view)
	}
	observe(reportHeaders, "0", initial.Desired.Revision, "platformTaskMode", "all")
	initial.Desired.Value["platformTaskMode"] = "only"
	saved := requestJSON[resource](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": initial.Desired.Revision, "value": initial.Desired.Value}, http.StatusOK, headers)
	if saved.Desired.Value["platformTaskMode"] != "only" || saved.Observation == nil || saved.Observation.Items[0].AppliedValue != "all" {
		t.Fatalf("save manufactured an application fact: %+v", saved)
	}
	observe(reportHeaders, saved.ObservationRevision, saved.Desired.Revision, "platformTaskMode", "only")
	legacy := read(legacyHeaders)
	if legacy.Desired.Value["preferPlatformSpecificTasks"] != true || legacy.Desired.Value["platformTaskMode"] != nil || legacy.Observation == nil || len(legacy.Observation.Items) != 0 {
		t.Fatalf("legacy projection differs: %+v", legacy)
	}
	legacy.Desired.Value["maxConcurrent"] = float64(2)
	requestJSON[resource](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": legacy.Desired.Revision, "value": legacy.Desired.Value}, http.StatusOK, legacyHeaders)
	retained := read(headers)
	if retained.Desired.Value["platformTaskMode"] != "only" || retained.Desired.Value["maxConcurrent"] != float64(2) {
		t.Fatalf("legacy edit changed strict target: %+v", retained)
	}
	legacyReportHeaders := legacyHeaders.Clone()
	legacyReportHeaders.Set("Daynight-Worker-Configuration", "1")
	observe(legacyReportHeaders, retained.ObservationRevision, retained.Desired.Revision, "preferPlatformSpecificTasks", true)
	oldReport := read(headers)
	if oldReport.Desired.Value["platformTaskMode"] != "only" || oldReport.Observation == nil {
		t.Fatalf("legacy report changed target: %+v", oldReport)
	}
	for _, observed := range oldReport.Observation.Items {
		if observed.Key.Kind == "platformTaskMode" {
			t.Fatalf("legacy report acquired strict support or application: %+v", oldReport)
		}
	}
	oldReport.Desired.Value["platformTaskMode"] = "all"
	left := requestJSON[resource](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": oldReport.Desired.Revision, "value": oldReport.Desired.Value}, http.StatusOK, headers)
	if left.Desired.Value["platformTaskMode"] != "all" {
		t.Fatalf("explicit exit differs: %+v", left)
	}
}
