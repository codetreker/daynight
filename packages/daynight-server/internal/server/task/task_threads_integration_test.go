package task_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const threadHTTPMessageID = "e5555555-e555-4555-8555-e55555555555"
const threadHTTPReplyID = "f6666666-f666-4666-8666-f66666666666"

func threadPath(task api.Task) string { return taskPath(task) + "/thread/messages" }
func threadHTTPPath() string {
	return taskCollection(testProjectID) + "/" + testTaskID + "/thread/messages"
}

func threadHTTPMessage(body string) model.ThreadMessage {
	return model.ThreadMessage{TaskID: testTaskID, ID: threadHTTPMessageID, Body: body, CreatedAt: testTime,
		Author: model.ThreadAuthor{UserID: testUserID}}
}

func threadHTTPDocument(t *testing.T, message model.ThreadMessage, details bool) taskservice.ThreadMessageDocument {
	t.Helper()
	data, err := codec.EncodeMessage(message, details)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.ThreadMessageDocument{Message: message, JSON: data}
}

func threadHTTPPageDocument(t *testing.T, page model.ThreadPage, details bool) taskservice.ThreadPageDocument {
	t.Helper()
	data, err := codec.EncodePage(page, details)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.ThreadPageDocument{Page: page, JSON: data}
}

func TestThreadHTTPResourcesAndExactBudgets(t *testing.T) {
	t.Run("message bytes and parameters", func(t *testing.T) {
		var logs bytes.Buffer
		h := newHTTPFixture(t, &logs)
		body := "  <>&\u2028\u2029 中文😀\n\t\"\\  "
		message := threadHTTPMessage(body)
		document := threadHTTPDocument(t, message, false)
		h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Body != body || input.ReplyTo != nil || input.ClaimID != nil {
				t.Fatalf("ordinary post input: %+v", input)
			}
			return document, nil
		}
		response := projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, map[string]any{"body": body}))
		got := decodeResponse[api.ThreadMessage](t, response, http.StatusCreated)
		if !bytes.Equal(response.Body.Bytes(), document.JSON) || got.ID != message.ID || got.Body != body || got.Author.UserID != testUserID || got.Author.Agent || got.Author.Execution != nil || got.ReplyTo != nil || len(got.CreatedAt) != 24 || got.CreatedAt[23] != 'Z' || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("Thread bytes/headers: %d %s", response.Code, response.Body)
		}
		if strings.Contains(logs.String(), body) || !strings.Contains(logs.String(), `"message_id":"`+message.ID+`"`) || !strings.Contains(logs.String(), `"component":"task_thread"`) || h.Tasks.TotalCalls() != 0 || h.Steps.TotalCalls() != 0 {
			t.Fatalf("Thread operation leaked content or crossed service boundaries: %s", &logs)
		}
	})
	t.Run("reply forwarding", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		message := threadHTTPMessage("reply")
		message.ID = threadHTTPReplyID
		replyTo := threadHTTPMessageID
		message.ReplyTo = &replyTo
		document := threadHTTPDocument(t, message, false)
		inputReply := strings.ToUpper(replyTo)
		h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Body != "reply" || input.ReplyTo == nil || *input.ReplyTo != inputReply || input.ClaimID != nil {
				t.Fatalf("reply input: %+v", input)
			}
			return document, nil
		}
		got := decodeResponse[api.ThreadMessage](t, projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, map[string]any{"body": "reply", "replyTo": inputReply})), http.StatusCreated)
		if got.ReplyTo == nil || *got.ReplyTo != replyTo || got.ID != message.ID {
			t.Fatal("service canonical reply identity was changed")
		}
	})
	for _, tc := range []struct {
		query string
		input taskservice.ThreadListRequest
		page  model.ThreadPage
	}{
		{"", taskservice.ThreadListRequest{Count: 50}, model.ThreadPage{Items: []model.ThreadMessage{}}},
		{"?count=1", taskservice.ThreadListRequest{Count: 1}, model.ThreadPage{Items: []model.ThreadMessage{threadHTTPMessage("tail")}, HasMoreBefore: true}},
		{"?beforeId=" + strings.ToUpper(threadHTTPReplyID), taskservice.ThreadListRequest{Count: 50, BeforeID: threadHTTPString(threadHTTPReplyID)}, model.ThreadPage{Items: []model.ThreadMessage{threadHTTPMessage("before")}, HasMoreAfter: true}},
		{"?afterId=" + strings.ToUpper(threadHTTPReplyID), taskservice.ThreadListRequest{Count: 50, AfterID: threadHTTPString(threadHTTPReplyID)}, model.ThreadPage{Items: []model.ThreadMessage{}}},
		{"?fromBeginning=true&count=1&details=true", taskservice.ThreadListRequest{Count: 1, FromBeginning: true, Details: true}, model.ThreadPage{Items: []model.ThreadMessage{threadHTTPMessage("first")}, HasMoreAfter: true}},
	} {
		t.Run("page/"+tc.query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			document := threadHTTPPageDocument(t, tc.page, tc.input.Details)
			h.Threads.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				if !reflect.DeepEqual(input, tc.input) {
					t.Fatalf("thread page input: %+v want %+v", input, tc.input)
				}
				return document, nil
			}
			response := projectRequest(h, http.MethodGet, threadHTTPPath()+tc.query, "")
			page := decodeResponse[api.ThreadPage](t, response, http.StatusOK)
			if !bytes.Equal(response.Body.Bytes(), document.JSON) || len(page.Items) != len(tc.page.Items) || page.HasMoreBefore != tc.page.HasMoreBefore || page.HasMoreAfter != tc.page.HasMoreAfter {
				t.Fatal("Thread page bytes or boundaries were changed")
			}
			if len(tc.page.Items) == 0 && response.Body.String() != `{"items":[],"hasMoreBefore":false,"hasMoreAfter":false}` {
				t.Fatalf("empty thread page: %s", response.Body)
			}
		})
	}
	t.Run("exact message is sent intact", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		message := threadHTTPMessage("x")
		probe := threadHTTPDocument(t, message, false)
		message.Body = strings.Repeat("x", codec.MessageLimit-(len(probe.JSON)-1))
		document := threadHTTPDocument(t, message, false)
		if len(document.JSON) != codec.MessageLimit {
			t.Fatalf("exact document size=%d", len(document.JSON))
		}
		h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Body != message.Body {
				t.Fatal("large message body changed before service")
			}
			return document, nil
		}
		response := projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, map[string]any{"body": message.Body}))
		decodeResponse[api.ThreadMessage](t, response, http.StatusCreated)
		if !bytes.Equal(response.Body.Bytes(), document.JSON) {
			t.Fatal("complete service document was truncated or re-encoded")
		}
	})
	for _, body := range []string{strings.Repeat("x", codec.MessageLimit+1), strings.Repeat("<", 11000)} {
		t.Run("service budget refusal/"+body[:1], func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				if input.Body != body {
					t.Fatal("budget input changed")
				}
				return taskservice.ThreadMessageDocument{}, &model.Fault{Code: "payload_too_large", Message: "Message resource exceeds its limit"}
			}
			assertProjectError(t, projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, map[string]any{"body": body})), http.StatusRequestEntityTooLarge, "payload_too_large")
		})
	}
}

func threadHTTPString(value string) *string { return &value }

func TestThreadHTTPStrictInputsAndRefusals(t *testing.T) {
	for _, body := range []string{
		`{}`, `{"body":null}`, `{"body":true}`, `{"body":{}}`, `{"body":[]}`, `{"body":123}`,
		`{"body":"x","body":"y"}`, `{"Body":"x"}`, `{"body":"x","id":"ignored"}`, `{"body":"x","author":{}}`, `{"body":"x","createdAt":"today"}`, `{"body":"x","version":1}`,
		`{"body":"x","replyTo":null}`, `{"body":"x","replyTo":3}`, `{"body":"x","claimId":null}`, `{"body":"x","claimId":false}`,
		`{"body":"x"} {}`, `[]`, `null`, `{"body":"` + string([]byte{0xff}) + `"}`,
	} {
		t.Run("body/"+body, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodPost, threadHTTPPath(), body), http.StatusBadRequest, "invalid_input")
			if h.Threads.TotalCalls() != 0 {
				t.Fatal("protocol rejection called Thread service")
			}
		})
	}
	for _, input := range []taskservice.CreateThreadMessage{{Body: ""}, {Body: " \n\t "}, {Body: "\x00"}, {Body: "x", ReplyTo: threadHTTPString("bad")}, {Body: "x", ClaimID: threadHTTPString("bad")}} {
		t.Run("domain/"+jsonBody(t, input), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, got taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				if !reflect.DeepEqual(got, input) {
					t.Fatalf("domain-invalid Thread input: %+v", got)
				}
				return taskservice.ThreadMessageDocument{}, &model.Fault{Code: "invalid_input", Message: "Invalid Thread message"}
			}
			body := map[string]any{"body": input.Body}
			if input.ReplyTo != nil {
				body["replyTo"] = *input.ReplyTo
			}
			if input.ClaimID != nil {
				body["claimId"] = *input.ClaimID
			}
			assertProjectError(t, projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, query := range []string{
		"count=0", "count=101", "count=-1", "count=1.5", "count=1e2", "count=not-a-number", "count=", "count=1&count=2",
		"beforeId=", "beforeId=bad", "afterId=bad", "beforeId=" + testTaskID + "&afterId=" + testTaskID,
		"beforeId=" + testTaskID + "&beforeId=" + testTaskID, "afterId=" + testTaskID + "&fromBeginning=false",
		"details=TRUE", "details=1", "details=", "details=true&details=false", "fromBeginning=1", "fromBeginning=true&beforeId=" + testTaskID,
		"limit=10", "cursor=token", "createdAt=now", "Count=1", "details=%zz",
	} {
		t.Run("query/"+query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodGet, threadHTTPPath()+"?"+query, ""), http.StatusBadRequest, "invalid_input")
			if h.Threads.TotalCalls() != 0 {
				t.Fatal("invalid Thread query reached service")
			}
		})
	}
	for _, tc := range []struct {
		field, code string
		status      int
	}{{"replyTo", "message_not_found", http.StatusNotFound}, {"claimId", "claim_conflict", http.StatusConflict}} {
		t.Run(tc.field, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				if input.Body != "x" || tc.field == "replyTo" && (input.ReplyTo == nil || *input.ReplyTo != testTaskID) || tc.field == "claimId" && (input.ClaimID == nil || *input.ClaimID != testTaskID) {
					t.Fatalf("Thread refusal input: %+v", input)
				}
				return taskservice.ThreadMessageDocument{}, &model.Fault{Code: tc.code, Message: "Thread resource cannot be used"}
			}
			assertProjectError(t, projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, map[string]any{"body": "x", tc.field: testTaskID})), tc.status, tc.code)
		})
	}
	for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		t.Run("method/"+method, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			response := projectRequest(h, method, threadHTTPPath(), "")
			assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
			if response.Header().Get("Allow") != "GET, HEAD, POST" || h.Threads.TotalCalls() != 0 {
				t.Fatal("Thread method admission changed")
			}
		})
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, path := range []string{taskCollection(testProjectID) + "/bad/thread/messages", "/api/v1/projects/bad/tasks/" + testTaskID + "/thread/messages"} {
			t.Run("path/"+method+path, func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				assertProjectError(t, projectRequest(h, method, path, `{"body":"x"}`), http.StatusBadRequest, "invalid_input")
				if h.Threads.TotalCalls() != 0 {
					t.Fatal("invalid resource path reached service")
				}
			})
		}
		for _, tc := range []struct {
			code   string
			status int
		}{{"not_found", http.StatusNotFound}, {"task_deleted", http.StatusGone}, {"forbidden", http.StatusForbidden}} {
			t.Run(method+"/"+tc.code, func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				if method == http.MethodGet {
					h.Threads.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
						assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
						return taskservice.ThreadPageDocument{}, &model.Fault{Code: tc.code, Message: "Thread parent unavailable"}
					}
				} else {
					h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
						assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
						return taskservice.ThreadMessageDocument{}, &model.Fault{Code: tc.code, Message: "Thread parent unavailable"}
					}
				}
				assertProjectError(t, projectRequest(h, method, threadHTTPPath(), `{"body":"x"}`), tc.status, tc.code)
			})
		}
	}
	t.Run("content type", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		request := httptest.NewRequest(http.MethodPost, threadHTTPPath(), strings.NewReader(`{"body":"x"}`))
		authorizeResourceRequest(h, request)
		request.Header.Set("Content-Type", "text/plain")
		request.Header.Set("X-Request-ID", "project-test")
		recorder := httptest.NewRecorder()
		h.ServeHTTP(recorder, request)
		assertProjectError(t, recorder, http.StatusBadRequest, "invalid_input")
		if h.Threads.TotalCalls() != 0 {
			t.Fatal("wrong Content-Type reached service")
		}
	})
	t.Run("HTTP body budget", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		assertProjectError(t, projectRequest(h, http.MethodPost, threadHTTPPath(), `{"body":"`+strings.Repeat("x", 1<<20)+`"}`), http.StatusRequestEntityTooLarge, "payload_too_large")
		if h.Threads.TotalCalls() != 0 {
			t.Fatal("oversized body reached service")
		}
	})
	for _, query := range []string{"?", "?count=1"} {
		t.Run("post query/"+query, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodPost, threadHTTPPath()+query, `{"body":"x"}`), http.StatusBadRequest, "invalid_input")
			if h.Threads.TotalCalls() != 0 {
				t.Fatal("Thread post query reached service")
			}
		})
	}
}
