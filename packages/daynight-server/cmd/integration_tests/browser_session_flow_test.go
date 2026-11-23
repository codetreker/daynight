//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

func browserSessionManagementNormalFlow(t *testing.T, f *fixture, current *http.Client) {
	t.Helper()
	other := testauth.Browser(t)
	t.Cleanup(other.CloseIdleConnections)
	testauth.Login(t, other, f.origin, "alice")
	const base = "/api/v1/me/browser-sessions"
	_, otherData := usageRequest(t, f, other, http.MethodGet, base, "", "", "", http.StatusOK)
	otherPage := usageDecode[struct {
		Current struct {
			ID string `json:"id"`
		} `json:"current"`
	}](t, otherData)
	response, data := usageRequest(t, f, current, http.MethodGet, base, "", "", "", http.StatusOK)
	page := usageDecode[struct {
		UserID  string `json:"userId"`
		Current struct {
			ID string `json:"id"`
		} `json:"current"`
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}](t, data)
	if page.UserID != f.userID || page.Current.ID == "" || otherPage.Current.ID == "" || otherPage.Current.ID == page.Current.ID || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("browser session list did not identify current and other sessions")
	}
	target := otherPage.Current.ID
	found := false
	for _, item := range page.Items {
		found = found || item.ID == target
	}
	if !found {
		t.Fatal("other browser session missing from list")
	}
	_, data = usageRequest(t, f, current, http.MethodGet, base+"/"+target, "", "", "", http.StatusOK)
	if view := usageDecode[struct {
		ID string `json:"id"`
	}](t, data); view.ID != target {
		t.Fatal("browser session detail identified the wrong target")
	}
	body, err := json.Marshal(map[string]string{"expectedUserId": page.UserID, "expectedSessionId": page.Current.ID})
	if err != nil {
		t.Fatal(err)
	}
	usageRequest(t, f, current, http.MethodPost, base+"/"+target+"/revoke", string(body), "application/json", "", http.StatusNoContent)
	_, data = usageRequest(t, f, current, http.MethodGet, base, "", "", "", http.StatusOK)
	after := usageDecode[struct {
		Current struct {
			ID string `json:"id"`
		} `json:"current"`
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}](t, data)
	if after.Current.ID != page.Current.ID {
		t.Fatal("revocation changed the current session")
	}
	for _, item := range after.Items {
		if item.ID == target {
			t.Fatal("revoked session remains in list")
		}
	}
}
