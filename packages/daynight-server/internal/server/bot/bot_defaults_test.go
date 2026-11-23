package bot_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
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
	t.Run("revoked PAT", func(t *testing.T) {
		if _, err := database.Pool.Exec(t.Context(), "DELETE FROM personal_access_tokens WHERE id=$1", handler.principal.CredentialID); err != nil {
			t.Fatal(err)
		}
		assertProjectError(t, projectRequest(handler, "GET", "/api/v1/me/bots/defaults", ""), 401, "unauthenticated")
		assertProjectError(t, projectRequest(handler, "POST", "/api/v1/me/bots", `{"id":"`+uuid.NewString()+`","name":"denied"}`), 401, "unauthenticated")
	})
}

const botDefaultsPath = botDefinitionsBase + "/defaults"

func botCreateRefusal(input botcore.CreateBot, code, message string) *botDefinitionCall {
	return &botDefinitionCall{method: "CreateResolved", input: input, err: &model.Fault{Code: code, Message: message}}
}

func botDefaultsResult(overrides model.BotOverrides, result botcore.BotDefaults, err error) *botDefinitionCall {
	return &botDefinitionCall{method: "DefaultsFor", input: overrides, result: result, err: err}
}

func TestBotDefaultsHTTPStrictCreateAndDefaultsInputs(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	const id = botDefinitionsID
	valid := `"id":"` + id + `","name":"assistant"`
	for _, body := range []string{
		`{}`, `null`, `[]`, `{"id":null,"name":"assistant"}`, `{"id":"` + id + `","name":null}`,
		`{` + valid + `,"extra":true}`, `{` + valid + `,"id":"` + id + `"}`,
		`{` + valid + `,"resolvedConfiguration":{}}`, `{` + valid + `,"overrides":null}`, `{` + valid + `,"overrides":[]}`,
		`{` + valid + `,"overrides":{"workerId":null}}`, `{` + valid + `,"overrides":{"cwd":null}}`, `{` + valid + `,"overrides":{"provider":null}}`,
		`{` + valid + `,"overrides":{"workerId":42}}`, `{` + valid + `,"overrides":{"cwd":false}}`, `{` + valid + `,"overrides":{"provider":{}}}`,
		`{` + valid + `,"overrides":{"unknown":"ignored"}}`, `{` + valid + `,"overrides":{"model":null}}`,
		`{` + valid + `,"overrides":{"reasoningEffort":null}}`, `{` + valid + `,"overrides":{"reasoningEffort":42}}`, `{` + valid + `,"overrides":{"cwd":"/one","cwd":"/two"}}`,
	} {
		assertProjectError(t, f.request("POST", botDefinitionsBase, body, nil), 400, "invalid_input")
	}
	assertProjectError(t, f.request("POST", botDefinitionsBase, `{"id":"bad","name":"assistant"}`,
		botCreateRefusal(botcore.CreateBot{ID: "bad", Name: "assistant"}, "invalid_input", "Invalid Bot ID.")), 400, "invalid_input")
	space := " "
	assertProjectError(t, f.request("POST", botDefinitionsBase, `{`+valid+`,"overrides":{"model":" "}}`,
		botCreateRefusal(botcore.CreateBot{ID: id, Name: "assistant", Overrides: model.BotOverrides{Model: &space}},
			"invalid_input", "Bot model must be nonempty Unicode without control characters and at most 256 UTF-8 bytes.")), 400, "invalid_input")

	modelID, effort := "model-a", "high"
	for _, test := range []struct {
		wire string
		want model.BotOverrides
	}{
		{`{"model":"model-a"}`, model.BotOverrides{Model: &modelID}},
		{`{"reasoningEffort":"high"}`, model.BotOverrides{ReasoningEffort: &effort}},
		{`{"model":"model-a","reasoningEffort":"high"}`, model.BotOverrides{Model: &modelID, ReasoningEffort: &effort}},
	} {
		assertProjectError(t, f.request("POST", botDefinitionsBase, `{`+valid+`,"overrides":`+test.wire+`}`,
			botCreateRefusal(botcore.CreateBot{ID: id, Name: "assistant", Overrides: test.want},
				"resource_conflict", "No Worker is available.")), 409, "resource_conflict")
	}
	for _, query := range []string{"?x=1", "?workerId=", "?workerId=" + id + "&workerId=" + id, "?workerId=%zz"} {
		assertProjectError(t, f.request("GET", botDefaultsPath+query, "", nil), 400, "invalid_input")
	}
	bad := "bad"
	assertProjectError(t, f.request("GET", botDefaultsPath+"?workerId=bad", "",
		botDefaultsResult(model.BotOverrides{WorkerID: &bad}, botcore.BotDefaults{},
			&model.Fault{Code: "invalid_input", Message: "Invalid Worker ID."})), 400, "invalid_input")
	for _, query := range []string{"?", "?workerId=" + id} {
		assertProjectError(t, f.request("POST", botDefinitionsBase+query, `{`+valid+`}`, nil), 400, "invalid_input")
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		response := f.request(method, botDefaultsPath, `{}`, nil)
		assertProjectError(t, response, 405, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("unexpected defaults methods: %v", response.Header())
		}
	}
	for _, path := range []string{botDefaultsPath, botDefinitionsBase} {
		assertProjectError(t, f.dispatch("GET", path, "", botDefinitionAnonymous, nil), 401, "unauthenticated")
	}
	assertProjectError(t, f.dispatch("POST", botDefinitionsBase, `{`+valid+`}`, botDefinitionAnonymous, nil), 401, "unauthenticated")
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
	f := newBotDefinitionsFixture(t, io.Discard)
	observedAt := time.Date(2026, 11, 8, 8, 0, 0, 0, time.FixedZone("fixture", 7*60*60))
	reason := "no_available_worker"
	response := f.request("GET", botDefaultsPath, "", botDefaultsResult(model.BotOverrides{}, botcore.BotDefaults{
		ObservedAt: observedAt, Reason: &reason,
	}, nil))
	value := decodeResponse[api.BotDefaults](t, response, http.StatusOK)
	want := api.BotDefaults{ObservedAt: observedAt.UTC(), Workers: []api.BotWorkerDefaults{}, Reason: &reason}
	if !reflect.DeepEqual(value, want) || response.Body.String() != jsonBody(t, want)+"\n" {
		t.Fatalf("empty defaults lost the unavailable result: %s", response.Body)
	}
}

func TestBotDefaultsHTTPCandidatesAndExplicitOfflineChoice(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	legacy := "b0000000-0000-4000-8000-000000000003"
	usable := botDefinitionsWorker
	observedAt := time.Date(2026, 11, 8, 8, 0, 0, 0, time.FixedZone("fixture", 7*60*60))
	machineID, machineName := "c0000000-0000-4000-8000-000000000003", "Usable Worker"
	modelID, missing := "gpt-5", "not_found"
	unsupported, offlineReason := "unsupported", "offline"
	configuration := func() *model.BotConfiguration {
		return &model.BotConfiguration{WorkerID: usable, Cwd: "/workspace", Provider: "copilot",
			Model: &modelID, Args: []string{"--effort", "high"}}
	}
	candidates := func(state string, reason *string, selected *model.BotConfiguration) []botcore.BotWorkerDefaults {
		return []botcore.BotWorkerDefaults{
			{WorkerID: legacy, State: "unsupported", Reason: &unsupported},
			{WorkerID: usable, Machine: model.WorkerMachine{ID: machineID, Name: machineName}, Platform: model.PlatformLinux,
				State: state, Reason: reason, Configuration: selected,
				Providers: []model.WorkerAssistantProvider{
					{Provider: model.AgentCodex, Available: true},
					{Provider: model.AgentClaude, Reason: &missing},
					{Provider: model.AgentCopilot, Available: true, Model: &modelID, Args: []string{"--effort", "high"}},
				}},
		}
	}
	response := f.request("GET", botDefaultsPath, "", botDefaultsResult(model.BotOverrides{}, botcore.BotDefaults{
		ObservedAt: observedAt, WorkerID: &usable, Configuration: configuration(), Workers: candidates("available", nil, configuration()),
	}, nil))
	defaults := decodeResponse[api.BotDefaults](t, response, 200)
	if defaults.ObservedAt != observedAt.UTC() || defaults.WorkerID == nil || *defaults.WorkerID != usable ||
		defaults.Configuration == nil || defaults.Configuration.WorkerID != usable || defaults.Reason != nil || len(defaults.Workers) != 2 {
		t.Fatalf("usable host projection: %+v", defaults)
	}
	wantLegacy := api.BotWorkerDefaults{WorkerID: legacy, State: "unsupported", Reason: &unsupported, Providers: []api.WorkerAssistantProvider{}}
	wantConfig := &api.BotConfiguration{WorkerID: usable, Cwd: "/workspace", Provider: "copilot",
		Model: &modelID, Args: []string{"--effort", "high"}}
	wantUsable := api.BotWorkerDefaults{WorkerID: usable, Machine: api.WorkerMachine{ID: machineID, Name: machineName}, Platform: "linux", State: "available", Configuration: wantConfig,
		Providers: []api.WorkerAssistantProvider{
			{Provider: "codex", Available: true, Args: []string{}},
			{Provider: "claude", Reason: &missing, Args: []string{}},
			{Provider: "copilot", Available: true, Model: &modelID, Args: []string{"--effort", "high"}},
		}}
	if !reflect.DeepEqual(defaults.Workers, []api.BotWorkerDefaults{wantLegacy, wantUsable}) ||
		!reflect.DeepEqual(defaults.Configuration, wantConfig) {
		t.Fatalf("candidate facts or effective provider defaults were lost: %s", response.Body)
	}

	uppercase := strings.ToUpper(usable)
	offline := decodeResponse[api.BotDefaults](t, f.request("GET", botDefaultsPath+"?workerId="+uppercase, "",
		botDefaultsResult(model.BotOverrides{WorkerID: &uppercase}, botcore.BotDefaults{
			ObservedAt: observedAt, WorkerID: &usable, Reason: &offlineReason, Workers: candidates("offline", &offlineReason, nil),
		}, nil)), 200)
	if offline.WorkerID == nil || *offline.WorkerID != usable || offline.Configuration != nil || offline.Reason == nil || *offline.Reason != "offline" {
		t.Fatalf("explicit offline host was replaced: %+v", offline)
	}
	foreign := botDefinitionsOtherID
	assertProjectError(t, f.request("GET", botDefaultsPath+"?workerId="+foreign, "",
		botDefaultsResult(model.BotOverrides{WorkerID: &foreign}, botcore.BotDefaults{},
			&model.Fault{Code: "forbidden", Message: "Bot and Worker must belong to the authenticated user."})), 403, "forbidden")
	assertProjectError(t, f.dispatch("GET", botDefaultsPath, "", botDefinitionRevoked, nil), 401, "unauthenticated")
	assertProjectError(t, f.dispatch("POST", botDefinitionsBase,
		`{"id":"`+botDefinitionsID+`","name":"denied"}`, botDefinitionRevoked, nil), 401, "unauthenticated")
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
	f := newBotDefinitionsFixtureForCredential(t, io.Discard, model.SessionCredential)
	body := `{"id":"` + botDefinitionsID + `","name":"browser"}`
	for _, origin := range []string{"", "https://another.example"} {
		assertProjectError(t, f.dispatchWithOrigin("POST", botDefinitionsBase, body, origin, botDefinitionOriginRefused, nil), 403, "forbidden")
	}
	assertProjectError(t, f.dispatchWithOrigin("POST", botDefinitionsBase, body, botExpiryOrigin, botDefinitionAdmitted,
		botCreateRefusal(botcore.CreateBot{ID: botDefinitionsID, Name: "browser"}, "resource_conflict", "No Worker is available.")), 409, "resource_conflict")
	reason := "no_available_worker"
	decodeResponse[api.BotDefaults](t, f.request("GET", botDefaultsPath, "",
		botDefaultsResult(model.BotOverrides{}, botcore.BotDefaults{
			ObservedAt: time.Date(2026, 11, 8, 1, 0, 0, 0, time.UTC), Reason: &reason,
		}, nil)), 200)
}

func TestBotCreationHTTPSelectionRefusals(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	foreign := botDefinitionsOtherID
	body := `{"id":"` + botDefinitionsID + `","name":"foreign","overrides":{"workerId":"` + foreign + `"}}`
	assertProjectError(t, f.request("POST", botDefinitionsBase, body,
		botCreateRefusal(botcore.CreateBot{ID: botDefinitionsID, Name: "foreign", Overrides: model.BotOverrides{WorkerID: &foreign}},
			"forbidden", "Bot and Worker must belong to the authenticated user.")), 403, "forbidden")

	body = `{"id":"` + botDefinitionsID + `","name":"overflow"}`
	assertProjectError(t, f.request("POST", botDefinitionsBase, body,
		botCreateRefusal(botcore.CreateBot{ID: botDefinitionsID, Name: "overflow"},
			"active_worker_limit_exceeded", "Active worker limit exceeded.")), 409, "active_worker_limit_exceeded")
}
