//go:build integration

package main

import (
	"net/http"
	"testing"
)

func serverAPIWorkerReviewSettingsFlow(t *testing.T, f *fixture, workerID string) {
	t.Helper()
	path := "/api/v1/me/workers/" + workerID + "/review-settings"
	type settings struct {
		Enabled *bool `json:"enabled"`
	}
	check := func(method string, body any, enabled bool) {
		t.Helper()
		got := requestJSON[settings](t, f, method, path, body, http.StatusOK)
		if got.Enabled == nil || *got.Enabled != enabled {
			t.Fatalf("%s review settings: got=%+v want enabled=%t", method, got, enabled)
		}
	}
	check(http.MethodGet, nil, false)
	check(http.MethodPut, settings{Enabled: new(true)}, true)
	check(http.MethodGet, nil, true)
	check(http.MethodPut, settings{Enabled: new(false)}, false)
	check(http.MethodGet, nil, false)
}
