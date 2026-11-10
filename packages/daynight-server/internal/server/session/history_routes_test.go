package session

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type historyRouteMock struct {
	current func(context.Context, model.Principal, string, string) (sp.TaskSessionCurrent, error)
	list    func(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error)
	read    func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error)
	entry   func(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error)
}

func (m historyRouteMock) Current(c context.Context, p model.Principal, a, b string) (sp.TaskSessionCurrent, error) {
	return m.current(c, p, a, b)
}
func (m historyRouteMock) List(c context.Context, p model.Principal, a, b, d string, n int) (sp.TaskSessionList, error) {
	return m.list(c, p, a, b, d, n)
}
func (m historyRouteMock) Read(c context.Context, p model.Principal, a, b, d string, q ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
	return m.read(c, p, a, b, d, q)
}
func (m historyRouteMock) Entry(c context.Context, p model.Principal, a, b, d string, q ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
	return m.entry(c, p, a, b, d, q)
}

type historyCloser func() error

func (f historyCloser) Close() error { return f() }

func TestHistoryRoutesValidateBeforeReadingAndRetainThroughWrite(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	const id = "33333333-3333-4333-8333-333333333333"
	base := "/api/v1/projects/" + project + "/tasks/" + task + "/sessions/" + id
	p := model.Principal{Kind: model.OAuthCredential, UserID: "owner", CredentialID: "oauth"}
	for _, test := range []struct {
		name, path, method string
		status, calls      int
	}{
		{"page", base + "/messages?limit=7&before=cursor&conversation=true", "GET", 200, 1},
		{"default", base + "/messages", "GET", 200, 1},
		{"chunk", base + "/message-content?cursor=body", "GET", 200, 1},
		{"limit", base + "/messages?limit=201", "GET", 400, 0},
		{"zero", base + "/messages?limit=0", "GET", 400, 0},
		{"duplicate", base + "/messages?limit=1&limit=2", "GET", 400, 0},
		{"filter", base + "/messages?conversation=1", "GET", 400, 0},
		{"unknown", base + "/messages?after=cursor", "GET", 400, 0},
		{"empty cursor", base + "/message-content?cursor=", "GET", 400, 0},
		{"missing cursor", base + "/message-content", "GET", 400, 0},
		{"cursor capacity", base + "/message-content?cursor=" + strings.Repeat("x", 4097), "GET", 400, 0},
		{"method", base + "/messages", "POST", 405, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls, closed := 0, 0
			check := func(ctx context.Context, actual model.Principal, a, b, c string) {
				calls++
				if ctx.Err() != nil || actual != p || a != project || b != task || c != id {
					t.Fatal("identity/context changed")
				}
			}
			closer := historyCloser(func() error { closed++; return nil })
			mock := historyRouteMock{
				read: func(ctx context.Context, p model.Principal, a, b, c string, q ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
					check(ctx, p, a, b, c)
					if q.ResponseOverhead != 1 {
						t.Fatalf("HTTP newline overhead %d", q.ResponseOverhead)
					}
					if test.name == "page" && (q.Limit != 7 || q.Before != "cursor" || !q.Conversation) {
						t.Fatalf("page query: %+v", q)
					}
					if test.name == "default" && q.Limit != 20 {
						t.Fatalf("default limit %d", q.Limit)
					}
					return ss.NewReadResult(sp.MessagePage{SessionID: id, Items: []sp.MessageItem{}}, closer), nil
				},
				entry: func(ctx context.Context, p model.Principal, a, b, c string, q ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
					check(ctx, p, a, b, c)
					if q.Cursor != "body" || q.ResponseOverhead != 1 {
						t.Fatalf("entry query: %+v", q)
					}
					return ss.NewReadResult(sp.EntryChunk{SessionID: id, Fragment: "hello"}, closer), nil
				},
			}
			mux := http.NewServeMux()
			RegisterHistoryRoutes(mux, mock, inspectionRouteAuth{p}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			writer := &historyResponseWriter{ResponseRecorder: httptest.NewRecorder(), beforeWrite: func() {
				if closed != 0 {
					t.Fatal("lease released before response write")
				}
			}}
			mux.ServeHTTP(writer, httptest.NewRequest(test.method, test.path, nil))
			if writer.Code != test.status || calls != test.calls || closed != test.calls {
				t.Fatalf("status=%d calls=%d closed=%d body=%s", writer.Code, calls, closed, writer.Body.String())
			}
			if writer.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("history is cacheable")
			}
		})
	}
}

type historyResponseWriter struct {
	*httptest.ResponseRecorder
	beforeWrite func()
}

func (w *historyResponseWriter) Write(p []byte) (int, error) {
	w.beforeWrite()
	return w.ResponseRecorder.Write(p)
}

func TestHistoryDirectoryViewKeepsLegacyDefaultAndPaging(t *testing.T) {
	const base = "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/sessions"
	p := model.Principal{Kind: model.OAuthCredential, UserID: "owner"}
	for _, test := range []struct {
		name, path    string
		status, calls int
		legacy        bool
	}{
		{"current", base + "/current?view=inspection", 200, 1, false},
		{"directory", base + "?view=inspection&limit=5&cursor=older", 200, 1, false},
		{"default", base + "/current", 204, 0, true},
		{"unknown view", base + "/current?view=other", 400, 0, false},
		{"duplicate", base + "/current?view=inspection&view=inspection", 400, 0, false},
		{"unexpected paging", base + "/current?view=inspection&limit=5", 400, 0, false},
		{"bad count", base + "?view=inspection&limit=201", 400, 0, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls, legacy := 0, false
			h := newRoutes(Operations{}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
			h.history = historyRouteMock{
				current: func(ctx context.Context, actual model.Principal, project, task string) (sp.TaskSessionCurrent, error) {
					calls++
					if ctx.Err() != nil || actual != p || project != "11111111-1111-4111-8111-111111111111" || task != "22222222-2222-4222-8222-222222222222" {
						t.Fatal("current scope changed")
					}
					return sp.TaskSessionCurrent{Status: "not_registered"}, nil
				},
				list: func(ctx context.Context, actual model.Principal, project, task, cursor string, limit int) (sp.TaskSessionList, error) {
					calls++
					if ctx.Err() != nil || actual != p || cursor != "older" || limit != 5 {
						t.Fatal("directory query changed")
					}
					return sp.TaskSessionList{Items: []sp.TaskSessionDirectoryItem{}}, nil
				},
			}
			mux := http.NewServeMux()
			wrapped := h.Parameters(func(w http.ResponseWriter, _ *http.Request, _ model.Principal) { legacy = true; w.WriteHeader(204) })
			for _, path := range []string{sessionBase, sessionBase + "/current"} {
				mux.HandleFunc("GET "+path, inspectionRouteAuth{p}.Require(wrapped))
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("GET", test.path, nil))
			if w.Code != test.status || calls != test.calls || legacy != test.legacy {
				t.Fatalf("status=%d calls=%d legacy=%v body=%s", w.Code, calls, legacy, w.Body.String())
			}
		})
	}
}

func TestHistoryReadCancellationReleasesReturnedLease(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started, closed, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	mock := historyRouteMock{read: func(ctx context.Context, _ model.Principal, _, _, _ string, _ ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
		close(started)
		<-ctx.Done()
		return ss.NewReadResult(sp.MessagePage{}, historyCloser(func() error { close(closed); return nil })), ctx.Err()
	}}
	mux := http.NewServeMux()
	RegisterHistoryRoutes(mux, mock, inspectionRouteAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := httptest.NewRequest("GET", "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/messages", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	go func() { defer close(done); mux.ServeHTTP(w, request) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("canceled read did not return")
	}
	select {
	case <-closed:
	default:
		t.Fatal("canceled result retained its lease")
	}
	if w.Body.Len() != 0 {
		t.Fatal("canceled read wrote a response")
	}
}

func TestHistoryRoutesPreserveControlledReadRefusals(t *testing.T) {
	for code, status := range map[string]int{"content_changed": 409, "upgrade_required": 501, "history_pending": 409, "history_unavailable": 503, "unsupported_mode": 400, "execution_changed": 409, "source_corrupt": 409, "forbidden": 403} {
		t.Run(code, func(t *testing.T) {
			calls := 0
			mock := historyRouteMock{read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
				calls++
				return nil, &model.Fault{Code: code, Message: "Controlled read refusal."}
			}}
			mux := http.NewServeMux()
			RegisterHistoryRoutes(mux, mock, inspectionRouteAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/messages", nil))
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if json.Unmarshal(w.Body.Bytes(), &envelope) != nil || w.Code != status || envelope.Error.Code != code || calls != 1 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
			}
		})
	}
}

func TestHistoryRoutesRejectMissingResults(t *testing.T) {
	mock := historyRouteMock{
		read: func(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
			return nil, nil
		},
		entry: func(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error) {
			return nil, nil
		},
	}
	mux := http.NewServeMux()
	RegisterHistoryRoutes(mux, mock, inspectionRouteAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, suffix := range []string{"messages", "message-content?cursor=body"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/"+suffix, nil))
		if w.Code != 500 || !strings.Contains(w.Body.String(), `"code":"internal_error"`) {
			t.Fatalf("missing result was treated as successful: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestHistoryHTTPBudgetIncludesEncodedBodyAndNewline(t *testing.T) {
	const id = "33333333-3333-4333-8333-333333333333"
	mock := historyRouteMock{read: func(_ context.Context, _ model.Principal, _, _, _ string, in ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error) {
		page := sp.MessagePage{SessionID: id, HistoryEpoch: "epoch", Source: "archive", Items: []sp.MessageItem{}, Coverage: sp.HistoryCoverage{State: "partial"}}
		reason := ""
		page.Coverage.Reason = &reason
		raw, err := json.Marshal(page)
		if err != nil {
			t.Fatal(err)
		}
		reason = strings.Repeat("x", sp.MaxHistoryResponseBytes-in.ResponseOverhead-len(raw))
		return ss.NewReadResult(page, nil), nil
	}}
	mux := http.NewServeMux()
	RegisterHistoryRoutes(mux, mock, inspectionRouteAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/sessions/"+id+"/messages", nil))
	if w.Code != 200 || w.Body.Len() != sp.MaxHistoryResponseBytes || w.Body.Bytes()[w.Body.Len()-1] != '\n' {
		t.Fatalf("status=%d complete response bytes=%d", w.Code, w.Body.Len())
	}
}
