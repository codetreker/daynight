package tag

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

func TestColorWritesPassOptionalFieldsAndKeepLegacyResponse(t *testing.T) {
	f := newFixture(t)
	f.ops.createColor = func(ctx context.Context, p model.Principal, project, name string, color *string) (service.WriteResult, error) {
		f.check(ctx, p, project)
		if name != "Alpha" || color == nil || *color != "#aBc123" {
			t.Fatalf("name=%q color=%v", name, color)
		}
		return committed(), nil
	}
	w := f.request("POST", collection, `{"name":"Alpha","color":"#aBc123"}`, true)
	result := decode[api.Tag](t, w, http.StatusCreated)
	if result.ID != tagID || result.Version != 7 || strings.Contains(w.Body.String(), `"color"`) {
		t.Fatalf("receipt: %s", w.Body)
	}

	for _, tc := range []struct {
		body        string
		name, color *string
	}{
		{`{"version":7,"name":"Beta","color":"#123456"}`, ptr("Beta"), ptr("#123456")},
		{`{"version":7,"name":"Beta"}`, ptr("Beta"), nil},
		{`{"version":7,"color":"#123456"}`, nil, ptr("#123456")},
	} {
		f.ops.update = func(ctx context.Context, p model.Principal, project, id string, version int64, name, color *string) (service.WriteResult, error) {
			f.check(ctx, p, project)
			if id != tagID || version != 7 || !same(name, tc.name) || !same(color, tc.color) {
				t.Fatalf("update: %s %d %v %v", id, version, name, color)
			}
			return committed(), nil
		}
		w := f.request("PATCH", collection+"/"+tagID, tc.body, true)
		updated := decode[api.Tag](t, w, http.StatusOK)
		if updated.ID != tagID || updated.Version != 7 || strings.Contains(w.Body.String(), `"color"`) {
			t.Fatalf("receipt: %s", w.Body)
		}
	}
}
func ptr(s string) *string   { return &s }
func same(a, b *string) bool { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

func TestResolveColorsResponseAndErrors(t *testing.T) {
	f := newFixture(t)
	missing := "30000000-0000-4000-8000-000000000002"
	epoch := "40000000-0000-4000-8000-000000000001"
	f.ops.resolveColors = func(ctx context.Context, p model.Principal, project string, ids []string, gotEpoch *string) (service.ColorPage, error) {
		f.check(ctx, p, project)
		if len(ids) != 2 || ids[0] != tagID || ids[1] != missing || !same(gotEpoch, &epoch) {
			t.Fatalf("input=%v epoch=%v", ids, gotEpoch)
		}
		return service.ColorPage{CatalogEpoch: epoch, Items: []service.ColorItem{{ID: tagID, Found: true, Version: 9223372036854775807, Color: "#ABCDEF"}, {ID: missing}}}, nil
	}
	w := f.request("POST", collection+"/colors/resolve", fmt.Sprintf(`{"tagIds":[%q,%q],"catalogEpoch":%q}`, tagID, missing, epoch), true)
	want := fmt.Sprintf("{\"catalogEpoch\":%q,\"items\":[{\"id\":%q,\"state\":\"found\",\"version\":9223372036854775807,\"color\":\"#ABCDEF\"},{\"id\":%q,\"state\":\"missing\"}]}\n", epoch, tagID, missing)
	if w.Code != 200 || w.Body.String() != want || w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response %d %s %v", w.Code, w.Body, w.Header())
	}
	for _, tc := range []struct {
		code   string
		status int
	}{{"catalog_changed", 409}, {"permission_denied", 403}, {"invalid_input", 400}} {
		f.ops.resolveColors = func(context.Context, model.Principal, string, []string, *string) (service.ColorPage, error) {
			return service.ColorPage{CatalogEpoch: epoch, Items: []service.ColorItem{{ID: tagID}}}, &model.Fault{Code: tc.code, Message: "failure"}
		}
		w := f.request("POST", collection+"/colors/resolve", `{"tagIds":[]}`, true)
		got := decode[api.ErrorResponse](t, w, tc.status)
		if got.Error.Code != tc.code || got.Error.RequestID != "tag-test" || strings.Contains(w.Body.String(), "items") {
			t.Fatalf("error %s", w.Body)
		}
	}
}

func TestResolveColorsLimitsAndCancellation(t *testing.T) {
	f := newFixture(t)
	length := (512 << 10) - len("{\"catalogEpoch\":\"epoch\",\"items\":[{\"id\":\"\",\"state\":\"missing\"}]}\n")
	f.ops.resolveColors = func(context.Context, model.Principal, string, []string, *string) (service.ColorPage, error) {
		return service.ColorPage{CatalogEpoch: "epoch", Items: []service.ColorItem{{ID: strings.Repeat("a", length)}}}, nil
	}
	w := f.request("POST", collection+"/colors/resolve", `{"tagIds":[]}`, true)
	if w.Code != http.StatusOK || w.Body.Len() != 512<<10 {
		t.Fatalf("exact response: status=%d length=%d", w.Code, w.Body.Len())
	}
	length++
	w = f.request("POST", collection+"/colors/resolve", `{"tagIds":[]}`, true)
	failure := decode[api.ErrorResponse](t, w, 409)
	if failure.Error.Code != "resource_limit_exceeded" || strings.Contains(w.Body.String(), "items") {
		t.Fatalf("response %s", w.Body)
	}
	f = newFixture(t)
	w = f.request("POST", collection+"/colors/resolve", `{"tagIds":[]}`+strings.Repeat(" ", 1<<20), true)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}

	f = newFixture(t)
	started := make(chan struct{})
	exited := make(chan struct{})
	f.ops.resolveColors = func(ctx context.Context, p model.Principal, project string, ids []string, epoch *string) (service.ColorPage, error) {
		close(started)
		<-ctx.Done()
		close(exited)
		return service.ColorPage{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), marker{}, f))
	r := httptest.NewRequest("POST", collection+"/colors/resolve", strings.NewReader(`{"tagIds":[]}`)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer credential")
	r.Header.Set("Content-Type", "application/json")
	done := make(chan struct{})
	go func() { f.handler.ServeHTTP(httptest.NewRecorder(), r); close(done) }()
	<-started
	cancel()
	for _, ch := range []<-chan struct{}{exited, done} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatal("cancellation did not exit")
		}
	}
}

func TestResolveColorsEmptyItemsAreArray(t *testing.T) {
	f := newFixture(t)
	f.ops.resolveColors = func(context.Context, model.Principal, string, []string, *string) (service.ColorPage, error) {
		return service.ColorPage{CatalogEpoch: "epoch"}, nil
	}
	w := f.request("POST", collection+"/colors/resolve", `{"tagIds":[]}`, true)
	var result map[string]json.RawMessage
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || string(result["items"]) != "[]" {
		t.Fatalf("response %d %s", w.Code, w.Body)
	}
}

func TestResolveColorsResponseFailureIsLoggedWithoutReplay(t *testing.T) {
	f := newFixture(t)
	calls := 0
	f.ops.resolveColors = func(context.Context, model.Principal, string, []string, *string) (service.ColorPage, error) {
		calls++
		return service.ColorPage{CatalogEpoch: "epoch"}, nil
	}
	r := httptest.NewRequest("POST", collection+"/colors/resolve", strings.NewReader(`{"tagIds":[]}`))
	r = r.WithContext(context.WithValue(r.Context(), marker{}, f))
	r.Header.Set("Authorization", "Bearer credential")
	r.Header.Set("Content-Type", "application/json")
	w := &failingWriter{header: make(http.Header)}
	f.handler.ServeHTTP(w, r)
	if calls != 1 || w.calls != 1 || !strings.Contains(f.logs.String(), `"phase":"response"`) {
		t.Fatalf("calls=%d writes=%d logs=%s", calls, w.calls, &f.logs)
	}
}
