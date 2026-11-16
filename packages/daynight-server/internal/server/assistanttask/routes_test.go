package assistanttask

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

const testTask = "11111111-1111-4111-8111-111111111111"
const testID = "22222222-2222-4222-8222-222222222222"
const testBot = "33333333-3333-4333-8333-333333333333"
const testTarget = "44444444-4444-4444-8444-444444444444"
const testOperation = "55555555-5555-4555-8555-555555555555"
const testToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const taskPath = "/api/v1/assistant-tasks/" + testTask
const claimBody = `"claimToken":"` + testToken + `","claimGeneration":"7"`

var testPrincipal = model.Principal{Kind: model.PATCredential, UserID: "66666666-6666-4666-8666-666666666666", CredentialID: "77777777-7777-4777-8777-777777777777"}

func pointer[T any](v T) *T { return &v }
func testHandler(t *testing.T, call func(context.Context, core.Actor, string, ...any) (any, error), logs io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind != model.PATCredential || secret != "secret" {
			return model.Principal{}, authhttp.Failure()
		}
		return testPrincipal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, &operationMock{call: call}, auth, logger)
	return mux
}
func request(handler http.Handler, method, path, body string, bot bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer secret")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if bot {
		req.Header.Set("X-Daynight-Bot-Id", testBot)
	}
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, req)
	return result
}
func assertError(t *testing.T, r *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body api.ErrorResponse
	if json.Unmarshal(r.Body.Bytes(), &body) != nil || r.Code != status || body.Error.Code != code {
		t.Fatalf("status=%d body=%s", r.Code, r.Body)
	}
}

func TestWriteRoutesPreserveInputsAndActor(t *testing.T) {
	mutation := core.Mutation{TaskID: testTask, ID: testID, ClaimToken: testToken, ClaimGeneration: 7}
	tests := []struct {
		method, path, body, name string
		bot                      bool
		args                     []any
	}{
		{"POST", "/api/v1/assistant-task-presets/watchdog", `{"id":"` + testID + `","targetBotId":"` + testTarget + `"}`, "EnableWatchdog", false, []any{testID, testTarget}},
		{"POST", "/api/v1/assistant-tasks", `{"id":"` + testID + `","name":"name","purpose":"purpose","scope":"scope","kind":"continuous","takeover":"auto","application":"app","trigger":{"minutes":1},"manual":{"body":"manual","rules":[]}}`, "Create", false, []any{core.CreateInput{ID: testID, Name: "name", Purpose: "purpose", Scope: "scope", Kind: "continuous", Takeover: "auto", Application: "app", Trigger: json.RawMessage(`{"minutes":1}`), Body: "manual", Rules: json.RawMessage(`[]`)}}},
		{"PATCH", taskPath, `{"ifVersion":"9007199254740993","name":"new","purpose":"purpose","scope":"scope","takeover":"manual","state":"paused","trigger":{"minutes":2}}`, "Update", false, []any{core.UpdateInput{TaskID: testTask, IfVersion: 9007199254740993, Name: pointer("new"), Purpose: pointer("purpose"), Scope: pointer("scope"), Takeover: pointer("manual"), State: pointer("paused"), Trigger: pointer(json.RawMessage(`{"minutes":2}`))}}},
		{"DELETE", taskPath, `{"ifVersion":"4"}`, "Update", false, []any{core.UpdateInput{TaskID: testTask, IfVersion: 4, State: pointer("deleted")}}},
		{"POST", taskPath + "/appendix", `{"id":"` + testID + `",` + claimBody + `,"text":"appendix","sourceRecords":["` + testID + `"]}`, "AddAppendix", true, []any{core.AppendixInput{Mutation: mutation, Text: "appendix", SourceRecords: []string{testID}}}},
		{"PATCH", taskPath + "/appendix/" + testID, `{"ifVersion":"8","text":"edited","sourceRecords":["` + testID + `"]}`, "UpdateAppendix", false, []any{core.AppendixInput{Mutation: core.Mutation{TaskID: testTask, ID: testID, IfVersion: 8}, Text: "edited", State: "edited", SourceRecords: []string{testID}}}},
		{"DELETE", taskPath + "/appendix/" + testID, `{"ifVersion":"9"}`, "UpdateAppendix", false, []any{core.AppendixInput{Mutation: core.Mutation{TaskID: testTask, ID: testID, IfVersion: 9}, State: "deleted"}}},
		{"POST", taskPath + "/proposals", `{"id":"` + testID + `",` + claimBody + `,"baseVersion":"2","body":"manual","rules":[],"reason":"reason","evidenceRecords":["` + testID + `"]}`, "Propose", true, []any{core.ProposalInput{Mutation: mutation, BaseVersion: 2, Body: "manual", Rules: json.RawMessage(`[]`), Reason: "reason", EvidenceRecords: []string{testID}}}},
		{"POST", taskPath + "/proposals/" + testID + "/decision", `{"ifVersion":"8","decision":"edited","body":"modified","rules":[],"note":"reason"}`, "Decide", false, []any{core.DecisionInput{TaskID: testTask, ID: testID, IfVersion: 8, Decision: "edited", Body: pointer("modified"), Rules: pointer(json.RawMessage(`[]`)), Note: "reason"}}},
		{"POST", taskPath + "/manual/rollback", `{"ifVersion":"8","manualVersion":"2"}`, "Rollback", false, []any{core.RollbackInput{TaskID: testTask, IfVersion: 8, ManualVersion: 2}}},
		{"POST", taskPath + "/items", `{"id":"` + testID + `",` + claimBody + `,"key":"key","episode":"3","state":"open","category":"stalled","appState":{"operation":"preserved"}}`, "SaveItem", true, []any{core.ItemInput{Mutation: mutation, Key: "key", Episode: 3, State: "open", Category: "stalled", AppState: json.RawMessage(`{"operation":"preserved"}`)}}},
		{"PATCH", taskPath + "/items/" + testID, `{` + claimBody + `,"ifVersion":"9007199254740993","key":"key","episode":"3","state":"closed","category":"stalled","appState":{}}`, "SaveItem", true, []any{core.ItemInput{Mutation: mutation, ItemVersion: pointer(int64(9007199254740993)), Key: "key", Episode: 3, State: "closed", Category: "stalled", AppState: json.RawMessage(`{}`)}}},
		{"POST", taskPath + "/records", `{"id":"` + testID + `",` + claimBody + `,"itemId":"` + testID + `","kind":"fact","text":"fact","refs":[]}`, "AddRecord", true, []any{core.RecordInput{Mutation: mutation, ItemID: pointer(testID), Kind: "fact", Text: "fact", Refs: json.RawMessage(`[]`)}}},
		{"POST", taskPath + "/events", `{"id":"` + testID + `",` + claimBody + `,"targetBotId":"` + testTarget + `","type":"trigger","payload":{"key":"value"}}`, "AddEvent", true, []any{core.EventInput{Mutation: mutation, TargetBotID: testTarget, Type: "trigger", Payload: json.RawMessage(`{"key":"value"}`)}}},
		{"POST", taskPath + "/events/" + testID + "/ack", `{"operationId":"` + testOperation + `"}`, "AckEvent", true, []any{core.AckEventInput{TaskID: testTask, ID: testID, OperationID: testOperation}}},
		{"POST", taskPath + "/events/" + testID + "/ack", `{"operationId":"` + testOperation + `","state":"expired"}`, "AckEvent", true, []any{core.AckEventInput{TaskID: testTask, ID: testID, OperationID: testOperation, State: "expired"}}},
		{"POST", "/api/v1/assistant-task-events/attention", `{"targetBotId":"` + testTarget + `"}`, "ClearAttention", false, []any{testTarget}},
		{"POST", taskPath + "/inquiries", `{"id":"` + testID + `","itemId":"` + testID + `","question":"question"}`, "Ask", true, []any{core.InquiryInput{Mutation: core.Mutation{TaskID: testTask, ID: testID}, ItemID: pointer(testID), Question: "question"}}},
		{"POST", taskPath + "/inquiries/" + testID + "/answer", `{` + claimBody + `,"answer":"answer"}`, "Answer", true, []any{core.AnswerInput{Mutation: mutation, Answer: "answer"}}},
	}
	for _, test := range tests {
		t.Run(test.name+test.method, func(t *testing.T) {
			calls := 0
			h := testHandler(t, func(ctx context.Context, actor core.Actor, name string, args ...any) (any, error) {
				calls++
				if name != test.name || !reflect.DeepEqual(args, test.args) || actor.Principal != testPrincipal || test.bot != (actor.BotID != nil) || actor.BotID != nil && *actor.BotID != testBot {
					t.Fatalf("call changed: %s %+v actor=%+v", name, args, actor)
				}
				return nil, nil
			}, io.Discard)
			response := request(h, test.method, test.path, test.body, test.bot)
			if response.Code != 200 || calls != 1 {
				t.Fatalf("calls=%d status=%d body=%s", calls, response.Code, response.Body)
			}
			calls = 0
			response = request(h, test.method, test.path, `{}`, test.bot)
			assertError(t, response, 400, "invalid_input")
			if calls != 0 {
				t.Fatal("invalid body invoked business operation")
			}
		})
	}
}

func TestClaimRoutesUseOperationSpecificFields(t *testing.T) {
	for _, test := range []struct {
		kind, path, body string
		bot              bool
		version          *int64
		generation       int64
		target           *string
	}{
		{"claim", "claim", `{"operationId":"` + testOperation + `","ifVersion":"2","expectedGeneration":"0","claimToken":"` + testToken + `"}`, true, pointer(int64(2)), 0, nil},
		{"transfer", "transfer", `{"operationId":"` + testOperation + `","ifVersion":"3","expectedGeneration":"7","targetBotId":"` + testTarget + `"}`, false, pointer(int64(3)), 7, pointer(testTarget)},
		{"transfer", "transfer", `{"operationId":"` + testOperation + `","ifVersion":"3","expectedGeneration":"7","targetBotId":"` + testTarget + `","claimToken":"` + testToken + `"}`, true, pointer(int64(3)), 7, pointer(testTarget)},
		{"bind", "claim/bind", `{"operationId":"` + testOperation + `","expectedGeneration":"7","claimToken":"` + testToken + `"}`, true, nil, 7, nil},
		{"renew", "renew", `{"operationId":"` + testOperation + `","claimGeneration":"7","claimToken":"` + testToken + `"}`, true, nil, 7, nil},
		{"release", "release", `{"operationId":"` + testOperation + `","expectedGeneration":"7","claimToken":"` + testToken + `"}`, true, nil, 7, nil},
		{"release", "release", `{"operationId":"` + testOperation + `","expectedGeneration":"7","ifVersion":"9"}`, false, pointer(int64(9)), 7, nil},
	} {
		t.Run(test.kind+test.body, func(t *testing.T) {
			calls := 0
			h := testHandler(t, func(_ context.Context, actor core.Actor, name string, args ...any) (any, error) {
				calls++
				input := args[0].(core.ClaimInput)
				token := ""
				if test.bot {
					token = testToken
				}
				want := core.ClaimInput{TaskID: testTask, OperationID: testOperation, Kind: test.kind, ClaimToken: token, TargetBotID: test.target, IfVersion: test.version, ExpectedGeneration: test.generation}
				if name != "Claim" || !reflect.DeepEqual(input, want) || test.bot != (actor.BotID != nil) {
					t.Fatalf("claim=%+v want=%+v", input, want)
				}
				return model.AssistantTaskClaimResult{Operation: model.AssistantTaskClaimOperation{OperationID: testOperation, ResultingGeneration: 9007199254740993, ResultingVersion: 9007199254740994}, CurrentClaim: model.AssistantTaskClaim{Generation: 9007199254740995, State: "expired"}}, nil
			}, io.Discard)
			response := request(h, "POST", taskPath+"/"+test.path, test.body, test.bot)
			if response.Code != 200 || calls != 1 || !strings.Contains(response.Body.String(), `"resultingGeneration":"9007199254740993"`) || !strings.Contains(response.Body.String(), `"claimGeneration":"9007199254740995"`) {
				t.Fatalf("response=%s calls=%d", response.Body, calls)
			}
			for _, body := range []string{`{}`, strings.TrimSuffix(test.body, "}") + `,"unexpected":true}`, strings.ReplaceAll(test.body, testOperation, "00000000-0000-0000-0000-000000000000"), strings.ReplaceAll(test.body, `"operationId":"`+testOperation+`"`, `"operationId":null`)} {
				calls = 0
				response = request(h, "POST", taskPath+"/"+test.path, body, test.bot)
				assertError(t, response, 400, "invalid_input")
				if calls != 0 {
					t.Fatal("malformed claim invoked operation")
				}
			}
		})
	}
}

func TestReadRoutesPreserveScopeAndPagination(t *testing.T) {
	tests := []struct {
		path, name string
		args       []any
		bot        bool
	}{
		{taskPath, "Get", []any{testTask}, false},
		{"/api/v1/assistant-tasks?limit=200&state=active&targetBotId=" + testTarget, "List", []any{core.PageInput{Limit: 200, State: "active", TargetBotID: testTarget}}, false},
		{taskPath + "/claim-operations/" + testOperation, "ClaimOperation", []any{testTask, testOperation}, false},
		{taskPath + "/manual", "GetManual", []any{testTask, int64(0)}, false},
		{taskPath + "/manual/versions/9007199254740993", "GetManual", []any{testTask, int64(9007199254740993)}, false},
		{taskPath + "/items/" + testID, "GetItem", []any{testTask, testID}, true},
		{taskPath + "/manual/versions?limit=2&cursor=opaque", "ListManuals", []any{testTask, core.PageInput{Limit: 2, Cursor: "opaque"}}, false},
		{taskPath + "/appendix?state=active", "ListAppendix", []any{testTask, core.PageInput{Limit: 50, State: "active"}}, false},
		{taskPath + "/proposals?state=pending", "ListProposals", []any{testTask, core.PageInput{Limit: 50, State: "pending"}}, false},
		{taskPath + "/items?state=open", "ListItems", []any{testTask, core.PageInput{Limit: 50, State: "open"}}, false},
		{taskPath + "/records?itemId=" + testID, "ListRecords", []any{testTask, core.PageInput{Limit: 50, ItemID: testID}}, false},
		{taskPath + "/events?state=pending&targetBotId=" + testTarget, "ListEvents", []any{testTask, core.PageInput{Limit: 50, State: "pending", TargetBotID: testTarget}}, false},
		{"/api/v1/assistant-task-events", "ListEvents", []any{"", core.PageInput{Limit: 50, TargetBotID: testBot}}, true},
		{taskPath + "/inquiries?state=open&itemId=" + testID, "ListInquiries", []any{testTask, core.PageInput{Limit: 50, State: "open", ItemID: testID}}, false},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			calls := 0
			h := testHandler(t, func(_ context.Context, actor core.Actor, name string, args ...any) (any, error) {
				calls++
				if name != test.name || !reflect.DeepEqual(args, test.args) || actor.Principal != testPrincipal {
					t.Fatalf("read %s %+v", name, args)
				}
				return nil, nil
			}, io.Discard)
			response := request(h, "GET", test.path, "", test.bot)
			if response.Code != 200 || calls != 1 || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response=%s calls=%d", response.Body, calls)
			}
			if strings.HasPrefix(test.name, "List") && !strings.Contains(response.Body.String(), `"items":[]`) {
				t.Fatal("empty list was not an array")
			}
			calls = 0
			sep := "?"
			if strings.Contains(test.path, "?") {
				sep = "&"
			}
			response = request(h, "GET", test.path+sep+"unexpected=1", "", test.bot)
			assertError(t, response, 400, "invalid_input")
			if calls != 0 {
				t.Fatal("unexpected query reached operation")
			}
		})
	}
}

func TestProtocolRefusalsNeverCallOperations(t *testing.T) {
	h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
		t.Fatal("refused request reached business operation")
		return nil, nil
	}, io.Discard)
	for _, test := range []struct {
		method, path, body string
		bot                bool
	}{
		{"GET", "/api/v1/assistant-tasks/bad", "", false},
		{"GET", taskPath + "/items/bad", "", false},
		{"GET", taskPath + "/manual/versions/01", "", false},
		{"GET", taskPath + "/manual/versions/0", "", false},
		{"GET", taskPath + "/records?itemId=bad", "", false},
		{"GET", taskPath + "/events?targetBotId=bad", "", false},
		{"PATCH", taskPath + "?unexpected=true", `{"ifVersion":"1","name":"updated"}`, false},
		{"POST", taskPath + "/claim", `{"operationId":"` + testOperation + `","ifVersion":"1","expectedGeneration":"0","claimToken":"bad"}`, true},
		{"POST", taskPath + "/claim", `{"operationId":"` + testOperation + `","ifVersion":"1","expectedGeneration":"0","claimToken":null}`, true},
		{"POST", taskPath + "/release", `{"operationId":"` + testOperation + `","expectedGeneration":"1","ifVersion":"1","claimToken":"` + testToken + `"}`, false},
		{"POST", taskPath + "/release", `{"operationId":"` + testOperation + `","expectedGeneration":"1","ifVersion":"1","claimToken":"` + testToken + `"}`, true},
		{"POST", taskPath + "/records", `{"id":"` + testID + `","kind":"note","text":"note","claimGeneration":"1"}`, true},
		{"POST", taskPath + "/records", `{"id":"` + testID + `","kind":"note","text":"note","refs":null}`, true},
		{"POST", taskPath + "/appendix", `{"id":"` + testID + `",` + claimBody + `,"text":"text","sourceRecords":[null]}`, true},
		{"POST", taskPath + "/appendix", `{"id":"` + testID + `",` + claimBody + `,"text":"text","sourceRecords":["bad"]}`, true},
	} {
		assertError(t, request(h, test.method, test.path, test.body, test.bot), 400, "invalid_input")
	}
	assertError(t, request(h, "PUT", taskPath, `{}`, true), 405, "method_not_allowed")
	req := httptest.NewRequest("GET", taskPath, nil)
	out := httptest.NewRecorder()
	h.ServeHTTP(out, req)
	assertError(t, out, 401, "unauthenticated")
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("X-Daynight-Bot-Id", "")
	out = httptest.NewRecorder()
	h.ServeHTTP(out, req)
	assertError(t, out, 400, "invalid_input")
}

func TestFaultsAndUnknownCompletionRetainPublicMeaning(t *testing.T) {
	lease := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "claim_lost", Message: "claim lost"}, 409, "claim_lost"},
		{&model.Fault{Code: "task_paused", Message: "paused"}, 409, "task_paused"},
		{model.ErrNotFound, 404, "not_found"},
		{&store.TransactionError{Outcome: store.TransactionNotCommitted, Phase: "operation", Cause: model.ErrNotFound}, 404, "not_found"},
		{&store.TransactionError{Outcome: store.TransactionNotCommitted, Phase: "operation", CleanupFailed: true, Cause: model.ErrNotFound}, 500, "internal_error"},
		{&model.Fault{Code: "task_deleted", Message: "deleted", Cause: model.ErrNotFound}, 410, "task_deleted"},
		{&model.AssistantTaskClaimError{Fault: &model.Fault{Code: "claim_held", Message: "claim held"}, Claim: model.AssistantTaskClaim{HolderBotID: pointer(testBot), Generation: 9007199254740993, LeaseUntil: &lease}}, 409, "claim_held"},
		{&model.Fault{Code: "forbidden", Message: "forbidden"}, 403, "forbidden"},
		{&model.Fault{Code: "task_deleted", Message: "deleted"}, 410, "task_deleted"},
		{&model.Fault{Code: "operation_conflict", Message: "conflict"}, 409, "operation_conflict"},
		{&service.WriteError{Operation: "Claim", Outcome: store.TransactionUnknown, Cause: errors.New(testToken)}, 503, "claim_outcome_unknown"},
		{&service.WriteError{Operation: "Claim", Outcome: store.TransactionCommitted, Cause: errors.New(testToken)}, 500, "internal_error"},
		{&store.TransactionError{Outcome: store.TransactionNotCommitted, Phase: "operation", CleanupFailed: true, Cause: &model.Fault{Code: "claim_lost", Message: testToken}}, 500, "internal_error"},
	} {
		t.Run(test.code, func(t *testing.T) {
			var logs bytes.Buffer
			calls := 0
			h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) { calls++; return nil, test.err }, &logs)
			response := request(h, "GET", taskPath, "", true)
			assertError(t, response, test.status, test.code)
			if calls != 1 || strings.Contains(response.Body.String(), testToken) || strings.Contains(logs.String(), testToken) {
				t.Fatalf("response or log leaked cause; calls=%d", calls)
			}
			if test.code == "claim_held" {
				var body api.ErrorResponse
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Error.Details == nil || *body.Error.Details.ClaimGeneration != 9007199254740993 || *body.Error.Details.HolderBotID != testBot || !body.Error.Details.LeaseUntil.Equal(lease) {
					t.Fatalf("claim details=%s err=%v", response.Body, err)
				}
			}
		})
	}
}

func TestEventAcknowledgementRejectsInvalidOutcomeBeforeCallingService(t *testing.T) {
	for _, state := range []string{`null`, `""`, `"pending"`, `true`, `1`} {
		t.Run(state, func(t *testing.T) {
			calls := 0
			h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
				calls++
				return model.AssistantTaskEvent{}, nil
			}, io.Discard)
			response := request(h, "POST", taskPath+"/events/"+testID+"/ack", `{"operationId":"`+testOperation+`","state":`+state+`}`, true)
			assertError(t, response, http.StatusBadRequest, "invalid_input")
			if calls != 0 {
				t.Fatalf("invalid outcome reached service %d times", calls)
			}
		})
	}
}

func TestCancellationReachesInvokedOperation(t *testing.T) {
	started, finished := make(chan struct{}), make(chan struct{})
	h := testHandler(t, func(ctx context.Context, _ core.Actor, _ string, _ ...any) (any, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return nil, ctx.Err()
	}, io.Discard)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("GET", taskPath, nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer secret")
	returned := make(chan struct{})
	go func() { defer close(returned); h.ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("operation did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("operation did not observe cancellation")
	}
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("handler did not return")
	}
}
