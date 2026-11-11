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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
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

type taskHTTPThreadScopeMock struct {
	taskHTTPMockBase
	CaptureDAOFn    func() store.WebhookCaptureDAO
	TaskDAOFn       func() store.ThreadTaskDAO
	CredentialDAOFn func() store.ThreadCredentialDAO
	ProjectDAOFn    func() store.ThreadProjectDAO
	ThreadDAOFn     func() store.ThreadDAO
}

func (mock *taskHTTPThreadScopeMock) CaptureDAO() store.WebhookCaptureDAO {
	mock.need("CaptureDAO", mock.CaptureDAOFn != nil)
	return mock.CaptureDAOFn()
}

func (mock *taskHTTPThreadScopeMock) TaskDAO() store.ThreadTaskDAO {
	mock.need("TaskDAO", mock.TaskDAOFn != nil)
	return mock.TaskDAOFn()
}

func (mock *taskHTTPThreadScopeMock) CredentialDAO() store.ThreadCredentialDAO {
	mock.need("CredentialDAO", mock.CredentialDAOFn != nil)
	return mock.CredentialDAOFn()
}

func (mock *taskHTTPThreadScopeMock) ProjectDAO() store.ThreadProjectDAO {
	mock.need("ProjectDAO", mock.ProjectDAOFn != nil)
	return mock.ProjectDAOFn()
}

func (mock *taskHTTPThreadScopeMock) ThreadDAO() store.ThreadDAO {
	mock.need("ThreadDAO", mock.ThreadDAOFn != nil)
	return mock.ThreadDAOFn()
}

var _ store.ThreadScope = (*taskHTTPThreadScopeMock)(nil)

type taskHTTPCredentialReaderMock struct {
	taskHTTPMockBase
	CredentialFn func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (mock *taskHTTPCredentialReaderMock) Credential(p0 context.Context, p1 model.Principal) (store.ThreadCredential, error) {
	mock.need("Credential", mock.CredentialFn != nil)
	return mock.CredentialFn(p0, p1)
}

var _ store.CredentialReader = (*taskHTTPCredentialReaderMock)(nil)

type taskHTTPThreadTaskMock struct {
	taskHTTPMockBase
	LockTaskPresenceFn func(context.Context, string, string) (store.TaskPresence, error)
	SourceTaskFn       func(context.Context, string, string) (model.Task, error)
}

func (mock *taskHTTPThreadTaskMock) LockTaskPresence(p0 context.Context, p1 string, p2 string) (store.TaskPresence, error) {
	mock.need("LockTaskPresence", mock.LockTaskPresenceFn != nil)
	return mock.LockTaskPresenceFn(p0, p1, p2)
}

func (mock *taskHTTPThreadTaskMock) SourceTask(p0 context.Context, p1 string, p2 string) (model.Task, error) {
	mock.need("SourceTask", mock.SourceTaskFn != nil)
	return mock.SourceTaskFn(p0, p1, p2)
}

var _ store.ThreadTaskDAO = (*taskHTTPThreadTaskMock)(nil)

type taskHTTPThreadCredentialMock struct {
	taskHTTPMockBase
	CredentialFn      func(context.Context, model.Principal) (store.ThreadCredential, error)
	CredentialValidFn func(context.Context, store.ThreadCredential) (bool, error)
	AuthorNameFn      func(context.Context, string) (*string, error)
}

func (mock *taskHTTPThreadCredentialMock) Credential(p0 context.Context, p1 model.Principal) (store.ThreadCredential, error) {
	mock.need("Credential", mock.CredentialFn != nil)
	return mock.CredentialFn(p0, p1)
}

func (mock *taskHTTPThreadCredentialMock) CredentialValid(p0 context.Context, p1 store.ThreadCredential) (bool, error) {
	mock.need("CredentialValid", mock.CredentialValidFn != nil)
	return mock.CredentialValidFn(p0, p1)
}

func (mock *taskHTTPThreadCredentialMock) AuthorName(p0 context.Context, p1 string) (*string, error) {
	mock.need("AuthorName", mock.AuthorNameFn != nil)
	return mock.AuthorNameFn(p0, p1)
}

var _ store.ThreadCredentialDAO = (*taskHTTPThreadCredentialMock)(nil)

type taskHTTPThreadProjectMock struct {
	taskHTTPMockBase
	LockProjectAuthorizationFn func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (mock *taskHTTPThreadProjectMock) LockProjectAuthorization(p0 context.Context, p1 model.Principal, p2 string) (model.ProjectAccess, error) {
	mock.need("LockProjectAuthorization", mock.LockProjectAuthorizationFn != nil)
	return mock.LockProjectAuthorizationFn(p0, p1, p2)
}

var _ store.ThreadProjectDAO = (*taskHTTPThreadProjectMock)(nil)

type taskHTTPThreadDAOMock struct {
	taskHTTPMockBase
	LockHeadFn         func(context.Context, string) (*model.ThreadPosition, error)
	ThreadMessageFn    func(context.Context, string, string) (model.ThreadMessage, error)
	InsertMessageFn    func(context.Context, model.ThreadMessage) (model.ThreadMessage, error)
	PrepareTimestampFn func(context.Context, *model.ThreadMessage, *model.ThreadPosition) error
	AdvanceHeadFn      func(context.Context, string, model.ThreadPosition) error
}

func (mock *taskHTTPThreadDAOMock) LockHead(p0 context.Context, p1 string) (*model.ThreadPosition, error) {
	mock.need("LockHead", mock.LockHeadFn != nil)
	return mock.LockHeadFn(p0, p1)
}

func (mock *taskHTTPThreadDAOMock) ThreadMessage(p0 context.Context, p1 string, p2 string) (model.ThreadMessage, error) {
	mock.need("ThreadMessage", mock.ThreadMessageFn != nil)
	return mock.ThreadMessageFn(p0, p1, p2)
}

func (mock *taskHTTPThreadDAOMock) InsertMessage(p0 context.Context, p1 model.ThreadMessage) (model.ThreadMessage, error) {
	mock.need("InsertMessage", mock.InsertMessageFn != nil)
	return mock.InsertMessageFn(p0, p1)
}

func (mock *taskHTTPThreadDAOMock) PrepareTimestamp(p0 context.Context, p1 *model.ThreadMessage, p2 *model.ThreadPosition) error {
	mock.need("PrepareTimestamp", mock.PrepareTimestampFn != nil)
	return mock.PrepareTimestampFn(p0, p1, p2)
}

func (mock *taskHTTPThreadDAOMock) AdvanceHead(p0 context.Context, p1 string, p2 model.ThreadPosition) error {
	mock.need("AdvanceHead", mock.AdvanceHeadFn != nil)
	return mock.AdvanceHeadFn(p0, p1, p2)
}

var _ store.ThreadDAO = (*taskHTTPThreadDAOMock)(nil)

func (f *taskCredentialFixture) expectThreadRead(current model.Task, items []model.ThreadMessage, accessError error) {
	current = copyTaskHTTPTask(current)
	items = copyThreadAuthenticationMessages(items)
	base := newTaskHTTPMockBase(f.t, "Thread HTTP read")
	project := &taskHTTPProjectReaderMock{taskHTTPMockBase: base}
	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		f.plan.Called("access")
		if actor != f.actor || id != f.project.ID || ctx.Err() != nil {
			f.fail("read authorization changed actor or Project")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = model.ProjectMemberRole
		return access, accessError
	}
	credentials := &taskHTTPCredentialReaderMock{taskHTTPMockBase: base}
	credentials.CredentialFn = func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
		f.plan.Called("credential")
		if actor != f.actor || ctx.Err() != nil {
			f.fail("Thread read changed credential identity")
		}
		return store.ThreadCredential{}, nil
	}
	reader := &taskHTTPReaderMock{taskHTTPMockBase: base}
	reader.TaskPresenceFn = func(ctx context.Context, project, task string) (store.TaskPresence, error) {
		f.plan.Called("presence")
		f.requireAddress(ctx, project, task)
		return store.TaskPresence{Found: true}, nil
	}
	reader.TaskFn = func(ctx context.Context, project, task string) (model.Task, error) {
		f.plan.Called("task")
		f.requireAddress(ctx, project, task)
		return copyTaskHTTPTask(current), nil
	}
	reader.TaskCacheEpochFn = func(ctx context.Context, project string) (string, error) {
		f.plan.Called("epoch")
		if project != f.project.ID || ctx.Err() != nil {
			f.fail("Task cache Project identity changed")
		}
		return "7", nil
	}
	reader.ThreadCandidatesFn = func(ctx context.Context, task string, anchor *model.ThreadPosition, before bool, count int) ([]model.ThreadMessage, error) {
		f.plan.Called("candidates")
		if task != f.task.ID || anchor != nil || !before || count != 51 || ctx.Err() != nil {
			f.fail("Thread page selection changed")
		}
		return copyThreadAuthenticationMessages(items), nil
	}
	reader.ThreadSidesFn = func(ctx context.Context, task string, first, last model.ThreadPosition) (bool, bool, error) {
		f.plan.Called("sides")
		if task != f.task.ID || len(items) != 2 || first != items[1].Position() || last != items[0].Position() || ctx.Err() != nil {
			f.fail("Thread page sides changed anchors")
		}
		return false, false, nil
	}
	snapshot := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base, CredentialDAOFn: func() store.CredentialReader { return credentials }, ProjectDAOFn: func() store.ProjectReader { return project }, TaskDAOFn: func() store.TaskReader { return reader }}
	f.database.ReadSnapshotCall = func(ctx context.Context, run func(store.SnapshotScope) error) error {
		f.plan.Called("snapshot")
		return run(snapshot)
	}
	f.database.WriteThreadCall = nil
}

func (f *taskCredentialFixture) expectPost(current model.Task, message model.ThreadMessage, accessError error) {
	current = copyTaskHTTPTask(current)
	message = copyThreadAuthenticationMessage(message)
	base := newTaskHTTPMockBase(f.t, "Thread HTTP post")
	tasks := &taskHTTPThreadTaskMock{taskHTTPMockBase: base}
	tasks.LockTaskPresenceFn = func(ctx context.Context, project, task string) (store.TaskPresence, error) {
		f.plan.Called("presence")
		f.requireAddress(ctx, project, task)
		return store.TaskPresence{Found: true}, nil
	}
	tasks.SourceTaskFn = func(ctx context.Context, project, task string) (model.Task, error) {
		f.plan.Called("source")
		f.requireAddress(ctx, project, task)
		return copyTaskHTTPTask(current), nil
	}
	credentials := &taskHTTPThreadCredentialMock{taskHTTPMockBase: base}
	credentials.CredentialFn = func(ctx context.Context, actor model.Principal) (store.ThreadCredential, error) {
		f.plan.Called("credential")
		if actor != f.actor || ctx.Err() != nil {
			f.fail("Thread post changed credential identity")
		}
		return store.ThreadCredential{}, nil
	}
	credentials.AuthorNameFn = func(ctx context.Context, user string) (*string, error) {
		f.plan.Called("author")
		if user != f.actor.UserID || ctx.Err() != nil {
			f.fail("Thread author lookup changed identity")
		}
		name := "Member"
		return &name, nil
	}
	credentials.CredentialValidFn = func(ctx context.Context, credential store.ThreadCredential) (bool, error) {
		f.plan.Called("valid")
		if credential.ExpiresAt != nil || ctx.Err() != nil {
			f.fail("Thread final admission changed locked credential")
		}
		return true, nil
	}
	projects := &taskHTTPThreadProjectMock{taskHTTPMockBase: base}
	projects.LockProjectAuthorizationFn = func(ctx context.Context, actor model.Principal, project string) (model.ProjectAccess, error) {
		f.plan.Called("access")
		if actor != f.actor || project != f.project.ID || ctx.Err() != nil {
			f.fail("Thread write authorization changed actor/Project")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = model.ProjectMemberRole
		return access, accessError
	}
	dao := &taskHTTPThreadDAOMock{taskHTTPMockBase: base}
	dao.LockHeadFn = func(ctx context.Context, task string) (*model.ThreadPosition, error) {
		f.plan.Called("head")
		if task != f.task.ID || ctx.Err() != nil {
			f.fail("Thread head lock changed Task")
		}
		return nil, nil
	}
	dao.InsertMessageFn = func(ctx context.Context, candidate model.ThreadMessage) (model.ThreadMessage, error) {
		f.plan.Called("insert")
		expected := copyThreadAuthenticationMessage(message)
		expected.ID, expected.CreatedAt = "", time.Time{}
		if !reflect.DeepEqual(candidate, expected) || ctx.Err() != nil {
			f.fail("candidate=%#v want=%#v", candidate, expected)
		}
		return copyThreadAuthenticationMessage(message), nil
	}
	dao.PrepareTimestampFn = func(ctx context.Context, candidate *model.ThreadMessage, head *model.ThreadPosition) error {
		f.plan.Called("timestamp")
		if !reflect.DeepEqual(*candidate, message) || head != nil || ctx.Err() != nil {
			f.fail("timestamp changed inserted message or head")
		}
		return nil
	}
	dao.AdvanceHeadFn = func(ctx context.Context, task string, position model.ThreadPosition) error {
		f.plan.Called("advance")
		if task != f.task.ID || position != message.Position() || ctx.Err() != nil {
			f.fail("Thread head advanced to a different message")
		}
		return nil
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base}
	capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
		f.plan.Called("capture")
		if project != f.project.ID || !reflect.DeepEqual(types, []string{protocol.ThreadPosted}) || ctx.Err() != nil {
			f.fail("Thread notification source changed")
		}
		return []store.WebhookAudience{}, nil
	}
	scope := &taskHTTPThreadScopeMock{taskHTTPMockBase: base, TaskDAOFn: func() store.ThreadTaskDAO { return tasks }, CredentialDAOFn: func() store.ThreadCredentialDAO { return credentials }, ProjectDAOFn: func() store.ThreadProjectDAO { return projects }, ThreadDAOFn: func() store.ThreadDAO { return dao }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.database.WriteThreadCall = func(ctx context.Context, run func(store.ThreadScope) error) (store.Completion, error) {
		f.plan.Called("write")
		err := run(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	f.database.ReadSnapshotCall = nil
}

func copyThreadAuthenticationMessage(message model.ThreadMessage) model.ThreadMessage {
	message.Author.DisplayName = copyTaskHTTPPointer(message.Author.DisplayName)
	message.Author.Execution = copyTaskHTTPPointer(message.Author.Execution)
	message.ReplyTo = copyTaskHTTPPointer(message.ReplyTo)
	return message
}

func copyThreadAuthenticationMessages(messages []model.ThreadMessage) []model.ThreadMessage {
	result := copyTaskHTTPSlice(messages)
	for index := range result {
		result[index] = copyThreadAuthenticationMessage(result[index])
	}
	return result
}

func TestThreadHTTPAuthenticationAndExecutionAttribution(t *testing.T) {
	f := newTaskThreadCredentialFixture(t)
	member := defaultHTTPPrincipal()
	admin := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	outsider := model.Principal{UserID: "99999999-9999-4999-8999-999999999999", CredentialID: "88888888-8888-4888-8888-888888888888", Kind: model.SessionCredential}
	memberSession := member
	memberSession.Kind = model.SessionCredential
	memberSession.CredentialID = "77777777-7777-4777-8777-777777777777"
	session := map[string]string{"Cookie": "__Host-daynight_session=" + httpTestToken(model.SessionCredential), "Origin": f.origin}
	foreign := map[string]string{"Cookie": session["Cookie"], "Origin": "https://foreign.example"}
	bearer := map[string]string{"Authorization": "Bearer " + defaultHTTPToken()}
	claim := model.WorkerClaim{ClaimID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", State: model.WorkerActive, UserID: member.UserID, WorkerID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Machine: model.WorkerMachine{ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Name: "Thread worker"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Phase: model.WorkerExecuting, ClaimedAt: f.task.CreatedAt}
	encoded, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	current := f.task
	current.Status, current.AllowAgents = model.TaskInProgress, true
	current.Properties = model.TaskProperties{"worker": encoded}
	path := "/api/v1/projects/" + f.project.ID + "/tasks/" + f.task.ID + "/thread/messages"
	body := map[string]any{"body": "Explicit authenticated discussion"}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodDelete} {
		code := "unauthenticated"
		if method == http.MethodHead {
			code = ""
		}
		response := f.request(model.Principal{}, method, path, body, nil, 401, code, map[string]int{})
		if method == http.MethodHead && response.Body.Len() != 0 {
			t.Fatal("anonymous HEAD returned a body")
		}
	}
	f.expectThreadRead(current, nil, model.ErrNotFound)
	f.request(outsider, http.MethodGet, path, nil, session, 403, "forbidden", taskCredentialCalls("snapshot", "credential", "access"))
	f.expectPost(current, model.ThreadMessage{}, model.ErrNotFound)
	f.request(outsider, http.MethodPost, path, body, session, 403, "forbidden", taskCredentialCalls("write", "presence", "credential", "access"))
	f.request(memberSession, http.MethodPost, path, body, foreign, 403, "forbidden", taskCredentialCalls())
	name := "Member"
	plain := model.ThreadMessage{TaskID: f.task.ID, ID: "00000000-0000-4000-8000-000000000001", Author: model.ThreadAuthor{UserID: member.UserID, DisplayName: &name}, Body: "Explicit authenticated discussion", CreatedAt: time.Date(2026, 1, 2, 3, 4, 6, 0, time.UTC)}
	f.expectPost(current, plain, nil)
	response := f.request(member, http.MethodPost, path, body, bearer, 201, "", taskCredentialCalls("write", "presence", "credential", "access", "author", "head", "insert", "timestamp", "valid", "advance", "capture"))
	plainResource := taskCredentialDecode[api.ThreadMessage](t, response)
	if plainResource.Author.UserID != member.UserID || plainResource.Author.Agent || plainResource.Author.Execution != nil {
		t.Fatal("PAT author was not derived from authenticated account")
	}
	body["claimId"] = claim.ClaimID
	agent := model.ThreadMessage{TaskID: f.task.ID, ID: "00000000-0000-4000-8000-000000000002", Author: model.ThreadAuthor{UserID: member.UserID, DisplayName: &name, Agent: true, Execution: &model.ThreadExecution{ClaimID: claim.ClaimID, WorkerID: claim.WorkerID, Provider: "codex"}}, Body: "Explicit authenticated discussion", CreatedAt: time.Date(2026, 1, 2, 3, 4, 7, 0, time.UTC)}
	f.expectPost(current, agent, nil)
	f.request(admin, http.MethodPost, path, body, session, 403, "forbidden", taskCredentialCalls("write", "presence", "credential", "access", "author", "source"))
	f.expectPost(current, agent, nil)
	response = f.request(member, http.MethodPost, path, body, bearer, 201, "", taskCredentialCalls("write", "presence", "credential", "access", "author", "source", "head", "insert", "timestamp", "valid", "advance", "capture"))
	agentResource := taskCredentialDecode[api.ThreadMessage](t, response)
	if !agentResource.Author.Agent || agentResource.Author.UserID != member.UserID || agentResource.Author.Execution != nil {
		t.Fatal("default author resource exposed details or lost Agent marker")
	}
	messages := []model.ThreadMessage{agent, plain}
	f.expectThreadRead(current, messages, nil)
	response = f.request(member, http.MethodGet, path+"?details=true", nil, bearer, 200, "", taskCredentialCalls("snapshot", "credential", "access", "presence", "candidates", "sides"))
	if response.Header().Get("Daynight-User-ID") != member.UserID {
		t.Fatal("Thread response lost authenticated identity header")
	}
	page := taskCredentialDecode[api.ThreadPage](t, response)
	if len(page.Items) != 2 || page.Items[0].Author.Execution != nil || page.Items[1].Author.Execution == nil || page.Items[1].Author.Execution.ClaimID != claim.ClaimID || page.Items[1].Author.Execution.WorkerID != claim.WorkerID || page.Items[1].Author.Execution.Provider != "codex" {
		t.Fatal("detailed author did not retain bounded verified execution source")
	}
	parent := newTaskCredentialFixture(t)
	parent.expectRead(current, nil)
	response = parent.request(member, http.MethodGet, "/api/v1/projects/"+f.project.ID+"/tasks/"+f.task.ID, nil, bearer, 200, "", taskCredentialCalls("snapshot", "access", "task", "epoch"))
	observed := taskCredentialDecode[api.Task](t, response)
	if observed.Version != current.Version || observed.UpdatedAt != current.UpdatedAt {
		t.Fatal("Thread Task observation changed metadata")
	}
	releasedClaim := claim
	releasedClaim.State = model.WorkerReleased
	releasedWorker, err := taskproperty.EncodeWorker(&releasedClaim)
	if err != nil {
		t.Fatal(err)
	}
	released := current
	released.Properties = model.TaskProperties{"worker": releasedWorker}
	f.expectPost(released, model.ThreadMessage{}, nil)
	f.request(member, http.MethodPost, path, body, bearer, 409, "claim_conflict", taskCredentialCalls("write", "presence", "credential", "access", "author", "source"))
	f.expectThreadRead(released, messages, nil)
	response = f.request(member, http.MethodGet, path+"?details=true", nil, bearer, 200, "", taskCredentialCalls("snapshot", "credential", "access", "presence", "candidates", "sides"))
	if taskCredentialDecode[api.ThreadPage](t, response).Items[1].Author.Execution.ClaimID != claim.ClaimID {
		t.Fatal("current claim state changed historical author attribution")
	}
	f.expectThreadRead(released, messages, nil)
	response = f.request(member, http.MethodHead, path, nil, bearer, 200, "", taskCredentialCalls("snapshot", "credential", "access", "presence", "candidates", "sides"))
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "application/json" {
		t.Fatal("HEAD returned a body or lost response metadata")
	}
	for _, private := range []string{defaultHTTPToken(), httpTestToken(model.SessionCredential), "Explicit authenticated discussion"} {
		if strings.Contains(f.logs.String(), private) {
			t.Fatal("Thread leaked credentials or discussion to logs")
		}
	}
}
