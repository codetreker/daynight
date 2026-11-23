//go:build integration

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func serverAPICORSNormalFlow(t *testing.T, f *fixture) {
	const applicationOrigin = "https://client.example"
	r, err := http.NewRequestWithContext(f.context, http.MethodOptions, f.origin+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", applicationOrigin)
	r.Header.Set("Access-Control-Request-Method", http.MethodGet)
	r.Header.Set("Access-Control-Request-Headers", "authorization, if-none-match, x-request-id")
	// The preflight uses the underlying transport without the PAT injector.
	transport := f.client.Transport.(tokenTransport).next
	preflight, err := (&http.Client{Transport: transport, Timeout: f.client.Timeout}).Do(r)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(preflight.Body)
	closeErr := preflight.Body.Close()
	if readErr != nil || closeErr != nil || preflight.StatusCode != http.StatusNoContent || len(data) != 0 || preflight.Header.Get("Access-Control-Allow-Origin") != applicationOrigin || preflight.Header.Get("Daynight-User-ID") != "" {
		t.Fatalf("credential-free preflight: status=%d headers=%v body=%s read=%v close=%v", preflight.StatusCode, preflight.Header, data, readErr, closeErr)
	}
	r, err = http.NewRequestWithContext(f.context, http.MethodGet, f.origin+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", applicationOrigin)
	r.Header.Set("X-Request-ID", "cors-normal-flow")
	response, err := f.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr = io.ReadAll(response.Body)
	closeErr = response.Body.Close()
	var user api.User
	if readErr != nil || closeErr != nil || response.StatusCode != http.StatusOK || json.Unmarshal(data, &user) != nil || user.ID != f.userID {
		t.Fatalf("cross-origin identity: status=%d body=%s read=%v close=%v", response.StatusCode, data, readErr, closeErr)
	}
	if response.Header.Get("Access-Control-Allow-Origin") != applicationOrigin || response.Header.Get("Daynight-User-ID") != user.ID || response.Header.Get("ETag") == "" || response.Header.Get("X-Request-ID") != "cors-normal-flow" || !strings.Contains(response.Header.Get("Access-Control-Expose-Headers"), "ETag") || response.Header.Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("cross-origin identity headers: %v", response.Header)
	}
}
