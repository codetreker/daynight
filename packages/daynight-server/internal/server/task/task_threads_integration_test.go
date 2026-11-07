package task_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func threadPath(task api.Task) string { return taskPath(task) + "/thread/messages" }

func TestThreadHTTPResourcesAndExactBudgets(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Thread parent")
	path := threadPath(task)
	empty := projectRequest(handler, http.MethodGet, path, "")
	if empty.Code != http.StatusOK || empty.Body.String() != `{"items":[],"hasMoreBefore":false,"hasMoreAfter":false}` {
		t.Fatalf("empty thread: %d %s", empty.Code, empty.Body)
	}
	body := "  <>&\u2028\u2029 中文😀\n\t\"\\  "
	response := projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"body": body}))
	first := decodeResponse[api.ThreadMessage](t, response, http.StatusCreated)
	if first.Body != body || first.Author.Agent || first.Author.UserID != handler.principal.UserID || first.Author.Execution != nil || len(first.CreatedAt) != 24 || first.CreatedAt[23] != 'Z' || first.ReplyTo != nil {
		t.Fatalf("message resource: %+v", first)
	}
	encoded, err := json.Marshal(first)
	if err != nil || !bytes.Equal(encoded, response.Body.Bytes()) || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Type") != "application/json" {
		t.Fatal("Thread response was re-encoded, newline-extended or incorrectly cacheable")
	}
	reply := decodeResponse[api.ThreadMessage](t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"body": "x", "replyTo": strings.ToUpper(first.ID)})), http.StatusCreated)
	if reply.ReplyTo == nil || *reply.ReplyTo != first.ID {
		t.Fatal("reply boundary was not canonicalized within the task")
	}
	page := decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path+"?count=1", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != reply.ID || !page.HasMoreBefore || page.HasMoreAfter {
		t.Fatalf("tail boundaries: %+v", page)
	}
	page = decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path+"?beforeId="+reply.ID, ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != first.ID || page.HasMoreBefore || !page.HasMoreAfter {
		t.Fatalf("before boundaries: %+v", page)
	}
	page = decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path+"?afterId="+reply.ID, ""), http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.HasMoreBefore || page.HasMoreAfter {
		t.Fatal("empty incremental page invented a boundary")
	}
	page = decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path+"?fromBeginning=true&count=1&details=true", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != first.ID || page.HasMoreBefore || !page.HasMoreAfter {
		t.Fatal("fromBeginning did not start a continuous initial page")
	}
	// Use the complete resource overhead, rather than a body-length proxy.
	probe := decodeResponse[api.ThreadMessage](t, projectRequest(handler, http.MethodPost, path, `{"body":"x"}`), http.StatusCreated)
	probeJSON, _ := json.Marshal(probe)
	exactBody := strings.Repeat("x", 65536-(len(probeJSON)-1))
	var bigIDs []string
	for range 4 {
		response = projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"body": exactBody}))
		message := decodeResponse[api.ThreadMessage](t, response, http.StatusCreated)
		if response.Body.Len() != 65536 || message.Body != exactBody {
			t.Fatalf("exact admission size=%d", response.Body.Len())
		}
		bigIDs = append(bigIDs, message.ID)
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"body": exactBody + "x"})), http.StatusRequestEntityTooLarge, "payload_too_large")
	assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"body": strings.Repeat("<", 11000)})), http.StatusRequestEntityTooLarge, "payload_too_large")
	response = projectRequest(handler, http.MethodGet, path+"?count=100", "")
	page = decodeResponse[api.ThreadPage](t, response, http.StatusOK)
	if response.Body.Len() > 262144 || len(page.Items) != 3 || page.Items[0].ID != bigIDs[1] || page.Items[2].ID != bigIDs[3] || !page.HasMoreBefore || page.HasMoreAfter {
		t.Fatalf("byte-limited tail: bytes=%d items=%d", response.Body.Len(), len(page.Items))
	}
	previous := decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path+"?beforeId="+page.Items[0].ID, ""), http.StatusOK)
	if len(previous.Items) != 4 || previous.Items[3].ID != bigIDs[0] || previous.HasMoreBefore || !previous.HasMoreAfter {
		t.Fatal("byte truncation skipped or duplicated messages")
	}
	if got := readHTTPTask(t, handler, task); !reflect.DeepEqual(got, task) {
		t.Fatal("Thread changed Task version, timestamps, state or properties")
	}
	other := createHTTPTask(t, handler, project.ID, "Other task")
	assertProjectError(t, projectRequest(handler, http.MethodGet, threadPath(other)+"?afterId="+first.ID, ""), http.StatusNotFound, "message_not_found")
	assertProjectError(t, projectRequest(handler, http.MethodPost, threadPath(other), jsonBody(t, map[string]any{"body": "cross reply", "replyTo": first.ID})), http.StatusNotFound, "message_not_found")
	for _, secret := range []string{body, exactBody, "Thread parent"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("Thread content leaked into logs")
		}
	}
	if !strings.Contains(logs.String(), `"component":"task_thread"`) || !strings.Contains(logs.String(), `"message_id":"`+first.ID+`"`) {
		t.Fatal("Thread commit has no safe message correlation")
	}
}

func TestThreadHTTPStrictInputsAndRefusals(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Strict Thread")
	path := threadPath(task)
	for _, body := range []string{
		`{}`, `{"body":null}`, `{"body":true}`, `{"body":{}}`, `{"body":[]}`, `{"body":123}`, `{"body":""}`, `{"body":" \n\t "}`,
		`{"body":"x","body":"y"}`, `{"Body":"x"}`, `{"body":"x","id":"ignored"}`, `{"body":"x","author":{}}`, `{"body":"x","createdAt":"today"}`, `{"body":"x","version":1}`,
		`{"body":"x","replyTo":null}`, `{"body":"x","replyTo":3}`, `{"body":"x","claimId":null}`, `{"body":"x","claimId":false}`,
		`{"body":"x","replyTo":"bad"}`, `{"body":"x","claimId":"bad"}`, `{"body":"\u0000"}`, `{"body":"x"} {}`, `[]`, `null`, `{"body":"` + string([]byte{0xff}) + `"}`,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, path, body), http.StatusBadRequest, "invalid_input")
	}
	for _, query := range []string{
		"count=0", "count=101", "count=-1", "count=1.5", "count=1e2", "count=not-a-number", "count=", "count=1&count=2",
		"beforeId=", "beforeId=bad", "afterId=bad", "beforeId=" + task.ID + "&afterId=" + task.ID,
		"beforeId=" + task.ID + "&beforeId=" + task.ID, "afterId=" + task.ID + "&fromBeginning=false",
		"details=TRUE", "details=1", "details=", "details=true&details=false", "fromBeginning=1", "fromBeginning=true&beforeId=" + task.ID,
		"limit=10", "cursor=token", "createdAt=now", "Count=1", "details=%zz",
	} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, path+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	for _, field := range []string{"replyTo", "claimId"} {
		code, status := "message_not_found", http.StatusNotFound
		if field == "claimId" {
			code, status = "claim_conflict", http.StatusConflict
		}
		assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"body": "x", field: task.ID})), status, code)
	}
	for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, path, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD, POST" {
			t.Fatal("invalid Thread Allow header")
		}
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		assertProjectError(t, projectRequest(handler, method, taskCollection(project.ID)+"/bad/thread/messages", `{"body":"x"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, method, "/api/v1/projects/bad/tasks/"+task.ID+"/thread/messages", `{"body":"x"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, method, taskCollection(project.ID)+"/00000000-0000-0000-0000-000000000001/thread/messages", `{"body":"x"}`), http.StatusNotFound, "not_found")
	}
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"body":"x"}`))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("X-Request-ID", "project-test")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	assertProjectError(t, recorder, http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(handler, http.MethodPost, path, `{"body":"`+strings.Repeat("x", 1<<20)+`"}`), http.StatusRequestEntityTooLarge, "payload_too_large")
	for _, query := range []string{"?", "?count=1"} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, path+query, `{"body":"x"}`), http.StatusBadRequest, "invalid_input")
	}
	page := decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if len(page.Items) != 0 {
		t.Fatal("invalid inputs appended a message")
	}
	task = setHTTPTask(t, handler, task, "done")
	decodeResponse[api.ThreadMessage](t, projectRequest(handler, http.MethodPost, path, `{"body":"Completed tasks retain discussion"}`), http.StatusCreated)
	decodeResponse[api.ThreadPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	response := projectRequest(handler, http.MethodDelete, taskPath(task), jsonBody(t, map[string]any{"version": task.Version}))
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete parent: %d %s", response.Code, response.Body)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		assertProjectError(t, projectRequest(handler, method, path, `{"body":"x"}`), http.StatusGone, "task_deleted")
	}
}
