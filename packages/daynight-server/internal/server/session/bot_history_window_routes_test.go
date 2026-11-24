package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func windowHTTPBoundary() sp.BotHistoryWindowBoundary {
	return sp.BotHistoryWindowBoundary{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "2"}, ConnectionEpoch: "3"}, BotHistoryWindowVersion: 1, HistoryEpoch: uuid.NewString(), WindowRevision: "7"}
}

func TestBotWindowHTTPHandshakeAcknowledgesOnlyNegotiatedCapability(t *testing.T) {
	for _, version := range []int{0, 1} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			f := newTestSessionRouteFixture(t)
			registration := independentRegistration("codex")
			snapshot := suppliedTestSnapshot(f.handler.principal, registration)
			connected := routeCopy(snapshot)
			connected.ConnectionEpoch, connected.ConnectionState = "1", "synchronizing"
			controller, _ := f.controller(t, snapshot, connected, registration, version)
			_ = controller.CloseNow()
		})
	}
}

func TestBotWindowHTTPReadValidatesAndPreservesBoundary(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	boundary := windowHTTPBoundary()
	path := "/api/v1/test-sessions/" + boundary.SessionID + "/bot-history-window"
	page := sp.BotHistoryWindowPage{BotHistoryWindowBoundary: boundary, Kind: "bot_history_window", Items: []sp.BotHistoryWindowEntry{}}
	expected := sessioncore.BotHistoryWindowRequest{Mode: "tail", Limit: 50}
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.ReadBotHistoryWindow = func(ctx context.Context, p model.Principal, project, task, id string, in sessioncore.BotHistoryWindowRequest) (sp.BotHistoryWindowPage, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(project == "" && task == "" && id == boundary.SessionID && in == expected, "window read arguments")
			return page, nil
		}
	})
	for _, query := range []string{"", "?mode=before&cursor=older&limit=1", "?mode=changes&cursor=updated&limit=200"} {
		if strings.Contains(query, "before") {
			expected = sessioncore.BotHistoryWindowRequest{Mode: "before", Cursor: "older", Limit: 1}
		} else if strings.Contains(query, "changes") {
			expected = sessioncore.BotHistoryWindowRequest{Mode: "changes", Cursor: "updated", Limit: 200}
		}
		f.expectNext("ReadBotHistoryWindow")
		response := f.request(http.MethodGet, path+query, "")
		actual := decodeResponse[sp.BotHistoryWindowPage](t, response, http.StatusOK)
		if !reflect.DeepEqual(actual, page) || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-Bot-History-Window-Version") != "1" {
			t.Fatal("window result changed", actual, response.Header())
		}
	}
	before := f.calls.TotalCalls()
	for _, query := range []string{"?unknown=1", "?mode=unknown", "?mode=before", "?mode=tail&cursor=old", "?mode=changes", "?limit=0", "?limit=201", "?limit=01", "?limit=x", "?limit=1&limit=2", "?mode=before&cursor=" + strings.Repeat("x", sp.MaxHistoryCursorBytes+1)} {
		assertProjectError(t, f.request(http.MethodGet, path+query, ""), 400, "invalid_input")
	}
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodPut} {
		if response := f.request(method, path, ""); response.Code != 405 || response.Header().Get("Allow") != "GET" {
			t.Fatal(method, response.Code, response.Body.String())
		}
	}
	if f.calls.TotalCalls() != before {
		t.Fatal("invalid window input invoked the service")
	}
}

func TestBotWindowHTTPResetCarriesCurrentBoundary(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	boundary := windowHTTPBoundary()
	through := "90"
	boundary.ThroughSeq, boundary.EarlierHistoryUnavailable = &through, true
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.ReadBotHistoryWindow = func(context.Context, model.Principal, string, string, string, sessioncore.BotHistoryWindowRequest) (sp.BotHistoryWindowPage, error) {
			return sp.BotHistoryWindowPage{}, &sessioncore.BotHistoryWindowResetError{Boundary: boundary}
		}
	})
	w := f.request(http.MethodGet, "/api/v1/test-sessions/"+boundary.SessionID+"/bot-history-window?mode=before&cursor=old", "")
	var got struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
		Boundary sp.BotHistoryWindowBoundary `json:"boundary"`
	}
	if w.Code != 409 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Error.Code != "reset_required" || !reflect.DeepEqual(got.Boundary, boundary) {
		t.Fatal("reset lost current retained boundary", w.Code, w.Body.String())
	}
}

func TestBotWindowCheckpointHTTPUsesControllerCredentialAndExactBody(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	f.auth.ExpectCalls(0)
	boundary := windowHTTPBoundary()
	checkpoint := sp.BotHistoryCheckpoint{BotHistoryWindowBoundary: boundary, SourceEpoch: uuid.NewString(), SourceThrough: "0", Entries: []sp.BotHistoryCheckpointEntry{}}
	receipt := sp.BotHistoryCheckpointReceipt{BotHistoryWindowBoundary: boundary, SourceEpoch: checkpoint.SourceEpoch, SourceThrough: "0", CleanupPending: true}
	credential := "dncontroller_window-original"
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.CommitBotHistoryCheckpoint = func(ctx context.Context, token string, in sp.BotHistoryCheckpoint) (sp.BotHistoryCheckpointReceipt, error) {
			f.argument(ctx != nil && ctx.Err() == nil && token == credential && reflect.DeepEqual(in, checkpoint), "checkpoint identity/body")
			return receipt, nil
		}
	})
	path := "/api/v1/test-sessions/" + boundary.SessionID + "/bot-history-window/checkpoint"
	send := func(method, target, body string, modify func(*http.Request)) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+credential)
		r.Header.Set("Content-Type", "application/json")
		if modify != nil {
			modify(r)
		}
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, r)
		return w
	}
	body := jsonBody(t, checkpoint)
	actual := decodeResponse[sp.BotHistoryCheckpointReceipt](t, send(http.MethodPut, path, body, nil), 200)
	if !reflect.DeepEqual(actual, receipt) {
		t.Fatal("committed cleanup-pending receipt changed", actual)
	}
	before := f.calls.TotalCalls()
	for _, tc := range []struct {
		name, target, body string
		modify             func(*http.Request)
	}{
		{"invalid body", path, "{}", nil},
		{"missing source epoch", path, strings.Replace(body, `"sourceEpoch":"`+checkpoint.SourceEpoch+`",`, "", 1), nil},
		{"empty source epoch", path, strings.Replace(body, checkpoint.SourceEpoch, "", 1), nil},
		{"unknown field", path, strings.TrimSuffix(body, "}") + `,"unexpected":true}`, nil},
		{"wrong path", strings.Replace(path, boundary.SessionID, uuid.NewString(), 1), body, nil},
		{"noncanonical path", strings.Replace(path, boundary.SessionID, strings.ToUpper(boundary.SessionID), 1), body, nil},
		{"query", path + "?extra=1", body, nil},
		{"PAT", path, body, func(r *http.Request) { r.Header.Set("Authorization", "Bearer dnpat_not-controller") }},
		{"duplicate token", path, body, func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+credential) }},
		{"origin", path, body, func(r *http.Request) { r.Header.Set("Origin", "https://different.example") }},
		{"protocol", path, body, func(r *http.Request) { r.Header.Set("Daynight-Session-Protocol", "daynight.session.v2") }},
		{"encoding", path, body, func(r *http.Request) { r.Header.Set("Content-Encoding", "gzip") }},
		{"media type", path, body, func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := send(http.MethodPut, tc.target, tc.body, tc.modify); w.Code < 400 {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	if w := send(http.MethodPost, path, body, nil); w.Code != 405 || w.Header().Get("Allow") != "PUT" {
		t.Fatal(w.Code, w.Body.String())
	}
	if f.calls.TotalCalls() != before {
		t.Fatal("invalid checkpoint invoked the service")
	}
}
