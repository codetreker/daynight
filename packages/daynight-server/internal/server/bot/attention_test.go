package bot

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

type attentionDefinitions struct {
	definitions
	value     model.Bot
	calls     int
	attention bool
	err       error
}

func (d *attentionDefinitions) CreateResolved(ctx context.Context, _ model.Principal, _ botcore.CreateBot) (model.Bot, error) {
	d.calls++
	d.attention = botcore.AttentionProjectionRequested(ctx)
	return d.value, d.err
}
func (d *attentionDefinitions) Get(ctx context.Context, _ model.Principal, _ string) (model.Bot, error) {
	d.calls++
	d.attention = botcore.AttentionProjectionRequested(ctx)
	return d.value, d.err
}
func (d *attentionDefinitions) List(ctx context.Context, _ model.Principal, _ model.PageRequest) (botcore.BotPage, error) {
	d.calls++
	d.attention = botcore.AttentionProjectionRequested(ctx)
	return botcore.BotPage{Items: []model.Bot{d.value}}, d.err
}
func (d *attentionDefinitions) ListWorker(ctx context.Context, _ model.Principal, _ string, _ model.PageRequest) (botcore.BotPage, error) {
	d.calls++
	d.attention = botcore.AttentionProjectionRequested(ctx)
	return botcore.BotPage{Items: []model.Bot{d.value}}, d.err
}

func TestBotAttentionScopeRefusalDoesNotAdvertiseProjection(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	principal := model.Principal{Kind: model.PATCredential, UserID: id, CredentialID: id}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) { return principal, nil }, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	d := &attentionDefinitions{err: &model.Fault{Code: "insufficient_scope", Message: "Credential scope is insufficient."}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, d, nil, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	request := httptest.NewRequest("POST", "/api/v1/me/bots", strings.NewReader(`{"id":"`+id+`","name":"Assistant"}`))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(attentionHeader, "1")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !d.attention || response.Header().Get(attentionHeader) != "" || response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" {
		t.Fatalf("refusal: %d %v %s", response.Code, response.Header(), response.Body)
	}
}

func TestBotAttentionResponseNegotiation(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	principal := model.Principal{Kind: model.PATCredential, UserID: id, CredentialID: id}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) { return principal, nil }, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	d := &attentionDefinitions{value: model.Bot{ID: id, WorkerID: id, OwnerUserID: id, Name: "Assistant", Version: 1}}
	mux := http.NewServeMux()
	RegisterRoutes(mux, d, nil, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	for _, count := range []int64{0, 3} {
		d.value.AttentionCount = count
		for _, route := range []struct {
			method, path, body string
			list               bool
		}{
			{"GET", "/api/v1/me/bots", "", true},
			{"GET", "/api/v1/me/bots/" + id, "", false},
			{"POST", "/api/v1/me/bots", `{"id":"` + id + `","name":"Assistant"}`, false},
			{"GET", "/api/v1/me/workers/" + id + "/bots", "", true},
		} {
			for _, header := range [][]string{nil, {"1"}, {"0"}, {"2"}, {"1", "1"}, {"1, 1"}, {""}} {
				req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
				req.Header.Set("Authorization", "Bearer secret")
				if route.body != "" {
					req.Header.Set("Content-Type", "application/json")
				}
				if header != nil {
					req.Header[attentionHeader] = header
				}
				d.calls = 0
				out := httptest.NewRecorder()
				mux.ServeHTTP(out, req)
				aware := len(header) == 1 && header[0] == "1"
				if header != nil && !aware {
					if out.Code != 400 || d.calls != 0 {
						t.Fatalf("unsupported capability reached business: header=%v status=%d calls=%d", header, out.Code, d.calls)
					}
					continue
				}
				if out.Code != 200 || d.calls != 1 || d.attention != aware || (out.Header().Get(attentionHeader) == "1") != aware {
					t.Fatalf("capability response: %s %d %s %v", route.path, out.Code, out.Body, out.Header())
				}
				var body map[string]json.RawMessage
				if err := json.Unmarshal(out.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if route.list {
					var items []map[string]json.RawMessage
					if err := json.Unmarshal(body["items"], &items); err != nil || len(items) != 1 {
						t.Fatalf("items: %s %v", out.Body, err)
					}
					body = items[0]
				}
				raw, present := body["attentionCount"]
				if present != aware {
					t.Fatalf("attention presence aware=%t: %s", aware, out.Body)
				}
				if aware {
					var got int64
					if err := json.Unmarshal(raw, &got); err != nil || got != count {
						t.Fatalf("attention count: %s %v", raw, err)
					}
				}
			}
		}
	}
	// Runtime response producers use the legacy projection regardless of the count.
	encoded, err := json.Marshal(Response(d.value))
	if err != nil || strings.Contains(string(encoded), "attentionCount") {
		t.Fatalf("legacy runtime response changed: %s %v", encoded, err)
	}
	d.value.Deletion = &model.BotDeletion{DeletionID: id, RequestedVersion: 1}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set(attentionHeader, "1")
	encoded, err = json.Marshal(responseForRequest(req, d.value))
	if err != nil || strings.Contains(string(encoded), "attentionCount") {
		t.Fatalf("deleted definition leaked attention: %s %v", encoded, err)
	}
}
