package assistanttask

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

const inboxPath = taskPath + "/inbox"
const inboxToken = "dnib_secret-inbox-token"

var inboxCreated = time.Date(2026, 11, 19, 8, 0, 0, 0, time.FixedZone("UTC+8", 8*3600))

func inboxResult(token string) core.InboxResult {
	return core.InboxResult{
		Operation: model.AssistantTaskClaimOperation{OperationID: testOperation, Kind: "inbox_enable", TaskID: testTask, RequestFingerprint: "fingerprint", AdmittedAt: inboxCreated, ResultingVersion: 9007199254740993, ResultingGeneration: 3, HolderBotID: pointer(testBot)},
		Inbox:     core.InboxView{InboxID: testID, Enabled: true, CreatedAt: &inboxCreated, SuppressedCount: 9007199254740993},
		Token:     token,
	}
}

func TestInboxWriteRoutesPreserveInputsAndExposeTokenOnlyWhenGenerated(t *testing.T) {
	body := `{"operationId":"` + testOperation + `","ifVersion":"9007199254740993"}`
	input := core.InboxInput{TaskID: testTask, OperationID: testOperation, IfVersion: 9007199254740993}
	rotate := input
	rotate.Mode = core.InboxRotateImmediate
	for _, test := range []struct {
		path, body, name string
		input            core.InboxInput
		token            bool
	}{
		{inboxPath + "/enable", body, "EnableInbox", input, true},
		{inboxPath + "/rotate", `{"operationId":"` + testOperation + `","ifVersion":"9007199254740993","mode":"immediate"}`, "RotateInbox", rotate, true},
		{inboxPath + "/disable", body, "DisableInbox", input, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			token := inboxToken
			h := testHandler(t, func(ctx context.Context, actor core.Actor, name string, args ...any) (any, error) {
				if name != test.name || actor.Principal != testPrincipal || actor.BotID != nil || !reflect.DeepEqual(args, []any{test.input}) {
					t.Fatalf("call changed: %s %+v actor=%+v", name, args, actor)
				}
				return inboxResult(token), nil
			}, io.Discard)
			response := request(h, "POST", test.path, test.body, false)
			var value map[string]json.RawMessage
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &value) != nil {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			want := `{"operation":{"operationId":"` + testOperation + `","kind":"inbox_enable","taskId":"` + testTask + `","requestFingerprint":"fingerprint","admittedAt":"2026-11-19T00:00:00Z","resultingVersion":"9007199254740993"},` +
				`"inbox":{"inboxId":"` + testID + `","enabled":true,"createdAt":"2026-11-19T00:00:00Z","rotatedAt":null,"overlapUntil":null,"suppressedCount":"9007199254740993"}`
			if test.token {
				want += `,"token":"` + inboxToken + `"`
			}
			if got := strings.TrimSpace(response.Body.String()); got != want+"}" {
				t.Fatalf("body=%s want=%s}", got, want)
			}
			if test.token {
				token = ""
				replay := request(h, "POST", test.path, test.body, false)
				if !strings.Contains(replay.Body.String(), `"token":null`) || strings.Contains(replay.Body.String(), inboxToken) {
					t.Fatalf("replay body=%s", replay.Body)
				}
			}
		})
	}
}

func TestInboxReadsReturnStateWithoutSecrets(t *testing.T) {
	calls := 0
	h := testHandler(t, func(ctx context.Context, actor core.Actor, name string, args ...any) (any, error) {
		calls++
		switch name {
		case "GetInbox":
			if !reflect.DeepEqual(args, []any{testTask}) {
				t.Fatalf("args=%v", args)
			}
			if actor.BotID != nil {
				return core.InboxView{}, nil
			}
			return inboxResult("").Inbox, nil
		case "InboxOperation":
			if actor.BotID != nil || !reflect.DeepEqual(args, []any{testTask, testOperation}) {
				t.Fatalf("args=%v actor=%+v", args, actor)
			}
			return inboxResult(inboxToken), nil
		}
		t.Fatalf("unexpected operation %s", name)
		return nil, nil
	}, io.Discard)
	response := request(h, "GET", inboxPath, "", false)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"inboxId":"`+testID+`"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	response = request(h, "GET", inboxPath, "", true)
	if got := strings.TrimSpace(response.Body.String()); response.Code != http.StatusOK || got != `{"inboxId":null,"enabled":false,"createdAt":null,"rotatedAt":null,"overlapUntil":null,"suppressedCount":"0"}` {
		t.Fatalf("Bot read: status=%d body=%s", response.Code, got)
	}
	response = request(h, "GET", taskPath+"/inbox-operations/"+testOperation, "", false)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "token") || !strings.Contains(response.Body.String(), `"operation":{"operationId":"`+testOperation) {
		t.Fatalf("receipt status=%d body=%s", response.Code, response.Body)
	}
	if calls != 3 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestInboxRefusalsNeverCallOperations(t *testing.T) {
	h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) {
		t.Fatal("refused request reached business operation")
		return nil, nil
	}, io.Discard)
	body := `{"operationId":"` + testOperation + `","ifVersion":"1"}`
	for _, path := range []string{inboxPath + "/enable", inboxPath + "/rotate", inboxPath + "/disable"} {
		assertError(t, request(h, "POST", path, body, true), http.StatusForbidden, "forbidden")
	}
	assertError(t, request(h, "GET", taskPath+"/inbox-operations/"+testOperation, "", true), http.StatusForbidden, "forbidden")
	for _, test := range []struct{ method, path, body string }{
		{"POST", inboxPath + "/enable", `{}`},
		{"POST", inboxPath + "/enable", ``},
		{"POST", inboxPath + "/enable", `{"operationId":"` + testOperation + `","ifVersion":"0"}`},
		{"POST", inboxPath + "/enable", `{"operationId":"` + testOperation + `","ifVersion":1}`},
		{"POST", inboxPath + "/enable", `{"operationId":"bad","ifVersion":"1"}`},
		{"POST", inboxPath + "/enable", `{"operationId":"` + testOperation + `","ifVersion":"1","mode":"overlap"}`},
		{"POST", inboxPath + "/enable?token=x", body},
		{"POST", inboxPath + "/disable", `{"operationId":"` + testOperation + `","ifVersion":"1","extra":true}`},
		{"POST", inboxPath + "/rotate", body},
		{"POST", inboxPath + "/rotate", `{"operationId":"` + testOperation + `","ifVersion":"1","mode":null}`},
		{"POST", inboxPath + "/rotate", `{"operationId":"` + testOperation + `","ifVersion":"1","mode":"later"}`},
		{"GET", inboxPath + "?verbose=1", ``},
		{"GET", taskPath + "/inbox-operations/bad", ``},
		{"GET", taskPath + "/inbox-operations/" + testOperation + "?x=1", ``},
		{"GET", "/api/v1/assistant-tasks/bad/inbox", ``},
	} {
		assertError(t, request(h, test.method, test.path, test.body, false), http.StatusBadRequest, "invalid_input")
	}
	response := request(h, "DELETE", inboxPath, "", false)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}
	response = request(h, "GET", inboxPath+"/enable", "", false)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "POST" {
		t.Fatalf("status=%d allow=%q", response.Code, response.Header().Get("Allow"))
	}
}

func TestInboxFaultsRetainPublicMeaning(t *testing.T) {
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "invalid_transition", Message: "already enabled"}, http.StatusConflict, "invalid_transition"},
		{&model.Fault{Code: "version_conflict", Message: "changed"}, http.StatusConflict, "version_conflict"},
		{&model.Fault{Code: "operation_conflict", Message: "reused"}, http.StatusConflict, "operation_conflict"},
		{&model.Fault{Code: "forbidden", Message: "forbidden"}, http.StatusForbidden, "forbidden"},
		{&model.Fault{Code: "task_deleted", Message: "deleted"}, http.StatusGone, "task_deleted"},
		{model.ErrNotFound, http.StatusNotFound, "not_found"},
		{&service.WriteError{Operation: "EnableInbox", Outcome: store.TransactionUnknown}, http.StatusServiceUnavailable, "write_outcome_unknown"},
	} {
		t.Run(test.code, func(t *testing.T) {
			h := testHandler(t, func(context.Context, core.Actor, string, ...any) (any, error) { return nil, test.err }, io.Discard)
			assertError(t, request(h, "POST", inboxPath+"/enable", `{"operationId":"`+testOperation+`","ifVersion":"1"}`, false), test.status, test.code)
		})
	}
}
