package task_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestThreadHTTPAgentPostPreservesActiveClaim(t *testing.T) {
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	message := threadHTTPMessage("Agent discussion")
	message.Author.Agent = true
	message.Author.Execution = &model.ThreadExecution{ClaimID: workerHTTPClaimID, WorkerID: workerHTTPWorkerID, Provider: "codex"}
	document := threadHTTPDocument(t, message, false)
	h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
		assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
		if input.Body != message.Body || input.ClaimID == nil || *input.ClaimID != workerHTTPClaimID || input.ReplyTo != nil {
			t.Fatalf("Agent post input: %+v", input)
		}
		return document, nil
	}
	posted := decodeResponse[api.ThreadMessage](t, projectRequest(h, http.MethodPost, threadHTTPPath(), jsonBody(t, map[string]any{"body": message.Body, "claimId": workerHTTPClaimID})), http.StatusCreated)
	if !posted.Author.Agent || posted.Author.UserID != testUserID || posted.ID != message.ID || posted.Author.Execution != nil {
		t.Fatalf("Agent resource projection: %+v", posted)
	}
	pageDocument := threadHTTPPageDocument(t, model.ThreadPage{Items: []model.ThreadMessage{message}}, true)
	h.Threads.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
		assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
		if !reflect.DeepEqual(input, taskservice.ThreadListRequest{Count: 50, Details: true}) {
			t.Fatalf("Agent details input: %+v", input)
		}
		return pageDocument, nil
	}
	response := projectRequest(h, http.MethodGet, threadHTTPPath()+"?details=true", "")
	page := decodeResponse[api.ThreadPage](t, response, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != message.ID || page.Items[0].Author.Execution == nil || page.Items[0].Author.Execution.ClaimID != workerHTTPClaimID || page.Items[0].Author.Execution.WorkerID != workerHTTPWorkerID || page.Items[0].Author.Execution.Provider != "codex" || !bytes.Equal(response.Body.Bytes(), pageDocument.JSON) {
		t.Fatal("Agent details lost verified attribution or document bytes")
	}
	if h.Tasks.TotalCalls() != 0 || h.Steps.TotalCalls() != 0 || strings.Contains(logs.String(), message.Body) || !strings.Contains(logs.String(), `"claim_id":"`+workerHTTPClaimID+`"`) || !strings.Contains(logs.String(), `"worker_id":"`+workerHTTPWorkerID+`"`) {
		t.Fatalf("Thread HTTP crossed Task mutation boundary or lost safe execution correlation: %s", &logs)
	}
}

func TestThreadHTTPReturnedDocumentResponseFailures(t *testing.T) {
	for _, mode := range []string{"failed", "short", "canceled_before_body"} {
		t.Run(mode, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			message := threadHTTPMessage("Committed private body")
			document := threadHTTPDocument(t, message, false)
			request := httptest.NewRequest(http.MethodPost, threadHTTPPath(), strings.NewReader(`{"body":"Committed private body"}`))
			authorizeResourceRequest(h, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "thread-response-failure")
			ctx, cancel := context.WithCancel(request.Context())
			defer cancel()
			request = request.WithContext(ctx)
			h.Threads.PostFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				if input.Body != message.Body {
					t.Fatal("post body was changed")
				}
				if mode == "canceled_before_body" {
					cancel()
				}
				return document, nil
			}
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short"}
			h.ServeHTTP(writer, request)
			if mode == "canceled_before_body" {
				if writer.calls != 0 || writer.Body.Len() != 0 || writer.Header().Get("Content-Type") != "" {
					t.Fatal("canceled returned document was written")
				}
			} else if writer.calls != 1 || writer.Code != http.StatusCreated {
				t.Fatalf("response failed with changed status or replay: %d/%d", writer.Code, writer.calls)
			}
			if h.Threads.Calls("Post") != 1 || h.Tasks.TotalCalls() != 0 || h.Steps.TotalCalls() != 0 || strings.Contains(logs.String(), message.Body) || strings.Contains(logs.String(), "private response failure") || !strings.Contains(logs.String(), `"message_id":"`+message.ID+`"`) {
				t.Fatalf("Thread result handling replayed business work or leaked private content: %s", &logs)
			}
		})
	}
}
