package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	"github.com/google/uuid"
)

func reportBotHostHTTP(t *testing.T, handler http.Handler, id string) {
	t.Helper()
	body := workerSnapshotReportBody()
	host := assistantHostBody()
	host["observedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	body["assistantHost"] = host
	reportSnapshotHTTP(t, handler, id, body)
}

func TestBotDefaultsHTTPNameOnlyCreate(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID := uuid.NewString()
	reportBotHostHTTP(t, handler, workerID)
	id := uuid.NewString()
	body := `{"id":"` + id + `","name":"  日常助手  "}`
	response := projectRequest(handler, "POST", "/api/v1/me/bots", body)
	bot := decodeResponse[api.Bot](t, response, http.StatusOK)
	if bot.ID != id || bot.Name != "日常助手" || bot.WorkerID != workerID || bot.ResolvedConfiguration.Cwd != "/workspace" || bot.ResolvedConfiguration.Provider != "copilot" || bot.StartupResult.State != "pending" {
		t.Fatalf("name-only creation did not resolve host defaults: %+v", bot)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatal("creation lacks private identity headers")
	}
	read := decodeResponse[api.Bot](t, projectRequest(handler, "GET", "/api/v1/me/bots/"+id, ""), 200)
	replay := decodeResponse[api.Bot](t, projectRequest(handler, "POST", "/api/v1/me/bots", body), 200)
	if !reflect.DeepEqual(bot, read) || !reflect.DeepEqual(bot, replay) {
		t.Fatal("response-loss reconciliation changed the frozen Bot")
	}
	assertProjectError(t, projectRequest(handler, "POST", "/api/v1/me/bots", `{"id":"`+id+`","name":"changed"}`), 409, "resource_conflict")
}

func TestBotDefaultsHTTPStrictCreateAndDefaultsInputs(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	id := uuid.NewString()
	valid := `"id":"` + id + `","name":"assistant"`
	for _, body := range []string{
		`{}`, `null`, `[]`, `{"id":null,"name":"assistant"}`, `{"id":"` + id + `","name":null}`,
		`{"id":"bad","name":"assistant"}`, `{` + valid + `,"extra":true}`, `{` + valid + `,"id":"` + id + `"}`,
		`{` + valid + `,"resolvedConfiguration":{}}`, `{` + valid + `,"overrides":null}`, `{` + valid + `,"overrides":[]}`,
		`{` + valid + `,"overrides":{"workerId":null}}`, `{` + valid + `,"overrides":{"cwd":null}}`, `{` + valid + `,"overrides":{"provider":null}}`,
		`{` + valid + `,"overrides":{"workerId":42}}`, `{` + valid + `,"overrides":{"cwd":false}}`, `{` + valid + `,"overrides":{"provider":{}}}`,
		`{` + valid + `,"overrides":{"model":"ignored"}}`, `{` + valid + `,"overrides":{"cwd":"/one","cwd":"/two"}}`,
	} {
		assertProjectError(t, projectRequest(handler, "POST", "/api/v1/me/bots", body), 400, "invalid_input")
	}
	for _, query := range []string{"?x=1", "?workerId=", "?workerId=bad", "?workerId=" + id + "&workerId=" + id, "?workerId=%zz"} {
		assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me/bots/defaults"+query, ""), 400, "invalid_input")
	}
	for _, query := range []string{"?", "?workerId=" + id} {
		assertProjectError(t, projectRequest(handler, "POST", "/api/v1/me/bots"+query, `{`+valid+`}`), 400, "invalid_input")
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		assertProjectError(t, projectRequest(handler, method, "/api/v1/me/bots/defaults", `{}`), 405, "method_not_allowed")
	}
	for _, path := range []string{"/api/v1/me/bots/defaults", "/api/v1/me/bots"} {
		assertProjectError(t, projectRequest(handler.Handler, "GET", path, ""), 401, "unauthenticated")
	}
	assertProjectError(t, projectRequest(handler.Handler, "POST", "/api/v1/me/bots", `{`+valid+`}`), 401, "unauthenticated")
}

func TestBotDefaultsHTTPExplicitOverridesAndOfflineReplay(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	workerID := uuid.NewString()
	reportBotHostHTTP(t, handler, workerID)
	id := uuid.NewString()
	body := `{"id":"` + id + `","name":"chosen","overrides":{"workerId":"` + strings.ToUpper(workerID) + `","cwd":"/not-present-on-server","provider":"codex"}}`
	bot := decodeResponse[api.Bot](t, projectRequest(handler, "POST", "/api/v1/me/bots", body), 200)
	if bot.RequestedOverrides.WorkerID == nil || *bot.RequestedOverrides.WorkerID != workerID || bot.RequestedOverrides.Cwd == nil || bot.RequestedOverrides.Provider == nil || bot.ResolvedConfiguration.Cwd != "/not-present-on-server" || bot.ResolvedConfiguration.Provider != "codex" || bot.ResolvedConfiguration.Model != nil || len(bot.ResolvedConfiguration.Args) != 0 {
		t.Fatalf("explicit configuration inherited another provider: %+v", bot)
	}
	if _, err := database.Pool.Exec(context.Background(), "UPDATE workers SET last_seen_at=statement_timestamp()-interval '10 minutes' WHERE user_id=$1 AND worker_id=$2", handler.principal.UserID, workerID); err != nil {
		t.Fatal(err)
	}
	replay := decodeResponse[api.Bot](t, projectRequest(handler, "POST", "/api/v1/me/bots", body), 200)
	if !reflect.DeepEqual(bot, replay) {
		t.Fatal("offline retry re-resolved a persisted request")
	}
	otherID := uuid.NewString()
	reportBotHostHTTP(t, handler, otherID)
	assertProjectError(t, projectRequest(handler, "POST", "/api/v1/me/bots", strings.Replace(body, id, uuid.NewString(), 1)), 409, "resource_conflict")
}

func TestBotDefaultsHTTPReadableEmptyDefaults(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	response := projectRequest(handler, "GET", "/api/v1/me/bots/defaults", "")
	value := decodeResponse[struct {
		ObservedAt    time.Time `json:"observedAt"`
		Workers       []any     `json:"workers"`
		Configuration any       `json:"configuration"`
		Reason        *string   `json:"reason"`
	}](t, response, http.StatusOK)
	if value.ObservedAt.IsZero() || value.Workers == nil || len(value.Workers) != 0 || value.Configuration != nil || value.Reason == nil {
		t.Fatalf("empty defaults lost the unavailable result: %s", response.Body)
	}
}

func TestBotDefaultsHTTPCandidatesAndExplicitOfflineChoice(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	legacy, usable := uuid.NewString(), uuid.NewString()
	reportSnapshotHTTP(t, handler, legacy, workerSnapshotReportBody())
	reportBotHostHTTP(t, handler, usable)
	response := projectRequest(handler, "GET", "/api/v1/me/bots/defaults", "")
	defaults := decodeResponse[api.BotDefaults](t, response, 200)
	if defaults.WorkerID == nil || *defaults.WorkerID != usable || defaults.Configuration == nil || defaults.Configuration.WorkerID != usable || defaults.Reason != nil || len(defaults.Workers) != 2 {
		t.Fatalf("usable host not selected: %+v", defaults)
	}
	if defaults.Workers[0].WorkerID != legacy || defaults.Workers[0].State != "unsupported" || defaults.Workers[0].Providers == nil || defaults.Workers[0].Configuration != nil || defaults.Workers[1].State != "available" || len(defaults.Workers[1].Providers) != 3 || defaults.Workers[1].Machine.ID == "" || defaults.Workers[1].Platform == "" {
		t.Fatalf("candidate facts were lost: %+v", defaults.Workers)
	}
	if defaults.Configuration.Model == nil || *defaults.Configuration.Model != "gpt-5" || !reflect.DeepEqual(defaults.Configuration.Args, []string{"--effort", "high"}) {
		t.Fatalf("effective provider defaults were lost: %+v", defaults.Configuration)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != handler.principal.UserID {
		t.Fatal("defaults lacks private identity headers")
	}
	if _, err := database.Pool.Exec(context.Background(), "UPDATE workers SET last_seen_at=statement_timestamp()-interval '10 minutes' WHERE user_id=$1 AND worker_id=$2", handler.principal.UserID, usable); err != nil {
		t.Fatal(err)
	}
	offline := decodeResponse[api.BotDefaults](t, projectRequest(handler, "GET", "/api/v1/me/bots/defaults?workerId="+strings.ToUpper(usable), ""), 200)
	if offline.WorkerID == nil || *offline.WorkerID != usable || offline.Configuration != nil || offline.Reason == nil || *offline.Reason != "offline" {
		t.Fatalf("explicit offline host was replaced: %+v", offline)
	}
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me/bots/defaults?workerId="+uuid.NewString(), ""), 403, "forbidden")
	if _, err := database.Pool.Exec(context.Background(), "DELETE FROM personal_access_tokens WHERE id=$1", handler.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me/bots/defaults", ""), 401, "unauthenticated")
	assertProjectError(t, projectRequest(handler, "POST", "/api/v1/me/bots", `{"id":"`+uuid.NewString()+`","name":"denied"}`), 401, "unauthenticated")
}

func TestBotDefaultsHTTPCreateLostResponseReconcilesOriginalID(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	workerID, id := uuid.NewString(), uuid.NewString()
	reportBotHostHTTP(t, handler, workerID)
	body := `{"id":"` + id + `","name":"single identity"}`
	request := httptest.NewRequest("POST", "/api/v1/me/bots", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	authorizeResourceRequest(handler, request)
	writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
	handler.ServeHTTP(writer, request)
	if writer.calls != 1 || writer.Body.Len() != 0 {
		t.Fatalf("unexpected response-loss fixture: %+v", writer)
	}
	read := decodeResponse[api.Bot](t, projectRequest(handler, "GET", "/api/v1/me/bots/"+id, ""), 200)
	replay := decodeResponse[api.Bot](t, projectRequest(handler, "POST", "/api/v1/me/bots", body), 200)
	page := decodeResponse[api.BotPage](t, projectRequest(handler, "GET", "/api/v1/me/bots", ""), 200)
	if !reflect.DeepEqual(read, replay) || len(page.Items) != 1 || page.Items[0].ID != id {
		t.Fatal("lost response produced another definition")
	}
}

func TestBotDefaultsHTTPBrowserCreationRequiresOrigin(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "bot-owner")
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	mux := http.NewServeMux()
	botsRoutes(mux, service.NewBots(h.database), sessionrelay.New(h.database), h.auth, logger)
	h.handler = RequestLogging(logger, mux)
	body := `{"id":"` + uuid.NewString() + `","name":"browser"}`
	for _, origin := range []string{"", "https://another.example"} {
		assertProjectError(t, h.request("POST", "/api/v1/me/bots", body, []*http.Cookie{cookie}, nil, origin), 403, "forbidden")
	}
	assertProjectError(t, h.request("POST", "/api/v1/me/bots", body, []*http.Cookie{cookie}, nil, h.auth.origin), 409, "resource_conflict")
	decodeResponse[api.BotDefaults](t, h.request("GET", "/api/v1/me/bots/defaults", "", []*http.Cookie{cookie}, nil, ""), 200)
}
