//go:build integration

package main

import (
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

func profileNormalFlow(t *testing.T, f *fixture, browser, plain *http.Client, pat string) {
	t.Helper()
	_, data := usageRequest(t, f, browser, http.MethodGet, "/api/v1/me", "", "", "", http.StatusOK)
	original := usageDecode[api.User](t, data)
	name, avatar := "  Local profile  ", "data:image/png;base64,cHJvZmlsZQ=="
	response, data := usageRequest(t, f, browser, http.MethodPatch, "/api/v1/me", `{"name":"  Local profile  ","avatarUrl":"data:image/png;base64,cHJvZmlsZQ=="}`, "application/json", "", http.StatusOK)
	changed := usageDecode[api.User](t, data)
	expected := original
	expected.Name, expected.AvatarURL = &name, &avatar
	if !reflect.DeepEqual(changed, expected) {
		t.Fatal("browser profile update changed unrelated identity or Personal Team fields")
	}
	if response.Header.Get("Daynight-User-ID") != f.userID || !strings.Contains(response.Header.Get("Cache-Control"), "no-store") {
		t.Fatal("profile update did not return its principal and no-store policy")
	}
	_, data = usageRequest(t, f, plain, http.MethodPatch, "/api/v1/me", `{"name":null}`, "application/json", pat, http.StatusOK)
	expected.Name = nil
	if actual := usageDecode[api.User](t, data); !reflect.DeepEqual(actual, expected) {
		t.Fatal("PAT sparse profile update did not clear name while retaining avatar and identity")
	}
	_, data = usageRequest(t, f, browser, http.MethodGet, "/api/v1/me", "", "", "", http.StatusOK)
	if actual := usageDecode[api.User](t, data); !reflect.DeepEqual(actual, expected) {
		t.Fatal("independent browser read did not return the committed PAT profile")
	}
	testauth.Login(t, browser, f.origin, "alice")
	_, data = usageRequest(t, f, plain, http.MethodGet, "/api/v1/me", "", "", pat, http.StatusOK)
	if actual := usageDecode[api.User](t, data); !reflect.DeepEqual(actual, original) {
		t.Fatal("native login did not restore the upstream profile on the same account and Personal Team")
	}
}
