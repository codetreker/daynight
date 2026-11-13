package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const searchTestID = "11111111-1111-4111-8111-111111111111"

func serveSearch(operation SearchOperation, logs *bytes.Buffer) *httptest.Server {
	return serveSearchWithTimeout(operation, logs, 5*time.Second)
}
func serveSearchWithTimeout(operation SearchOperation, logs *bytes.Buffer, timeout time.Duration) *httptest.Server {
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	h := searchHandler{run: operation, logger: logger, operationTimeout: timeout}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tasks/search", func(w http.ResponseWriter, r *http.Request) {
		h.search(w, r, model.Principal{Kind: model.PATCredential, UserID: searchTestID, CredentialID: searchTestID})
	})
	return httptest.NewServer(httpx.RequestLogging(logger, mux))
}
func postSearch(t *testing.T, server *httptest.Server, body string) (int, string) {
	t.Helper()
	client := server.Client()
	client.Timeout = 5 * time.Second
	response, err := client.Post(server.URL+"/api/v1/projects/"+searchTestID+"/tasks/search", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("cache header missing")
	}
	return response.StatusCode, string(data)
}
func failedSearchOperation(err error) SearchOperation {
	return func(context.Context, model.Principal, string, tasksearch.Request) (tasksearch.Page, error) {
		return tasksearch.Page{}, err
	}
}

func TestTaskSearchRoutesApplyDefaultOperationDeadline(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	principal := model.Principal{Kind: model.PATCredential, UserID: searchTestID, CredentialID: searchTestID}
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		if kind != model.PATCredential || credential != "test-pat" {
			t.Errorf("credential input=%s %s", kind, credential)
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	calls := 0
	before := time.Now()
	TaskSearchRoutes(mux, func(ctx context.Context, actor model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		calls++
		deadline, exists := ctx.Deadline()
		after := time.Now()
		if !exists || deadline.Before(before.Add(5*time.Second)) || deadline.After(after.Add(5*time.Second)) || actor != principal || projectID != searchTestID || input.Query != "cache" {
			t.Errorf("default operation deadline=%s exists=%t actor=%+v project=%s input=%+v", deadline, exists, actor, projectID, input)
		}
		return tasksearch.Page{ProjectID: projectID, Items: []tasksearch.Item{}}, nil
	}, auth, logger)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+searchTestID+"/tasks/search", strings.NewReader(`{"query":"cache"}`))
	request.Header.Set("Authorization", "Bearer test-pat")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	httpx.RequestLogging(logger, mux).ServeHTTP(response, request)
	if response.Code != 200 || calls != 1 {
		t.Fatalf("default route response=%d %s calls=%d", response.Code, response.Body, calls)
	}
}

func TestSearchHTTPExpressionErrorAndPrivacy(t *testing.T) {
	var logs bytes.Buffer
	calls := 0
	operation := func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if projectID != searchTestID || principal.UserID != searchTestID || input.Query != "私人文本 AND (A" {
			t.Fatalf("search arguments=%+v %s %+v", principal, projectID, input)
		}
		return tasksearch.Page{}, &model.Fault{Code: "invalid_search_expression", Message: "Search expression is invalid.", SearchExpression: &model.SearchExpressionDetails{Reason: "unclosed_group", Position: 10, Length: 1}}
	}
	server := serveSearch(operation, &logs)
	t.Cleanup(server.Close)
	status, body := postSearch(t, server, `{"query":"私人文本 AND (A"}`)
	var result struct {
		Error struct {
			Code    string `json:"code"`
			Details struct {
				Reason   string `json:"reason"`
				Position int    `json:"position"`
				Length   int    `json:"length"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		t.Fatal(err)
	}
	if status != 400 || result.Error.Code != "invalid_search_expression" || result.Error.Details.Reason != "unclosed_group" || result.Error.Details.Position != 10 || result.Error.Details.Length != 1 || calls != 1 {
		t.Fatalf("status=%d body=%s calls=%d", status, body, calls)
	}
	status, body = postSearch(t, server, `{"query":"ok","cursor":null,"unknown":1}`)
	if status != 400 || calls != 1 {
		t.Fatalf("unknown field reached operation: status=%d body=%s calls=%d", status, body, calls)
	}
	if strings.Contains(logs.String(), "私人文本") {
		t.Fatal("query leaked into log")
	}
}

func TestSearchHTTPDeadlineAndFailurePrivacy(t *testing.T) {
	var logs bytes.Buffer
	server := serveSearch(failedSearchOperation(&store.Error{Phase: "SQL secret", Cause: errors.New("driver secret")}), &logs)
	t.Cleanup(server.Close)
	status, body := postSearch(t, server, `{"query":"private query"}`)
	if status != 500 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	for _, secret := range []string{"private query", "SQL secret", "driver secret"} {
		if strings.Contains(logs.String(), secret) || strings.Contains(body, secret) {
			t.Fatalf("leaked %q: body=%s logs=%s", secret, body, &logs)
		}
	}
}

func TestSearchHTTPCallerCancellationPropagatesToOperation(t *testing.T) {
	var logs bytes.Buffer
	started, finished, release := make(chan struct{}), make(chan error, 1), make(chan struct{})
	operation := func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		if projectID != searchTestID || principal.UserID != searchTestID || input.Query != "cache" {
			t.Errorf("search args=%s %+v %+v", projectID, principal, input)
		}
		close(started)
		select {
		case <-ctx.Done():
			finished <- ctx.Err()
			return tasksearch.Page{}, ctx.Err()
		case <-release:
			return tasksearch.Page{}, errors.New("test operation released during cleanup")
		}
	}
	server := serveSearch(operation, &logs)
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/v1/projects/"+searchTestID+"/tasks/search", strings.NewReader(`{"query":"cache"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	returned := make(chan error, 1)
	go func() {
		response, err := server.Client().Do(request)
		if response != nil {
			response.Body.Close()
		}
		returned <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("search operation did not start")
	}
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("operation cancellation=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("operation did not observe caller cancellation")
	}
	select {
	case err := <-returned:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("caller cancellation=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP client did not finish")
	}
}

func TestSearchHTTPOperationDeadlineCancelsOperation(t *testing.T) {
	var logs bytes.Buffer
	expired := make(chan error, 1)
	started := make(chan time.Duration, 1)
	release := make(chan struct{})
	operation := func(ctx context.Context, _ model.Principal, _ string, _ tasksearch.Request) (tasksearch.Page, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Error("operation lacks its deadline")
		}
		started <- time.Until(deadline)
		select {
		case <-ctx.Done():
			expired <- ctx.Err()
			return tasksearch.Page{}, ctx.Err()
		case <-release:
			return tasksearch.Page{}, errors.New("test operation released during cleanup")
		}
	}
	server := serveSearchWithTimeout(operation, &logs, 40*time.Millisecond)
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })
	status, body := postSearch(t, server, `{"query":"cache"}`)
	select {
	case remaining := <-started:
		if remaining <= 0 || remaining > 40*time.Millisecond {
			t.Fatalf("deadline remaining=%s", remaining)
		}
	default:
		t.Fatal("operation never started")
	}
	select {
	case err := <-expired:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("deadline=%v", err)
		}
	default:
		t.Fatal("operation did not expire")
	}
	if status != 504 || !strings.Contains(body, `"code":"search_timeout"`) || !strings.Contains(logs.String(), `"cause":"search_timeout"`) {
		t.Fatalf("status=%d body=%s logs=%s", status, body, &logs)
	}
}

func TestSearchHTTPTransactionFailureIsNotTimeout(t *testing.T) {
	var logs bytes.Buffer
	server := serveSearch(failedSearchOperation(&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}), &logs)
	t.Cleanup(server.Close)
	status, body := postSearch(t, server, `{"query":"cache"}`)
	if status != 500 || !strings.Contains(body, `"internal_error"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("status=%d body=%s logs=%s", status, body, &logs)
	}
}

func TestSearchHTTPDeadlineDoesNotHideCompletionFailures(t *testing.T) {
	for _, test := range []struct {
		name    string
		cleanup bool
	}{{"commit", false}, {"cleanup", true}} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var logs bytes.Buffer
			expired := make(chan error, 1)
			release := make(chan struct{})
			operation := func(ctx context.Context, _ model.Principal, _ string, _ tasksearch.Request) (tasksearch.Page, error) {
				select {
				case <-ctx.Done():
				case <-release:
					return tasksearch.Page{}, errors.New("test operation released during cleanup")
				}
				expired <- ctx.Err()
				if test.cleanup {
					return tasksearch.Page{}, &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: errors.Join(ctx.Err(), errors.New("cleanup failed"))}
				}
				return tasksearch.Page{}, &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: errors.Join(ctx.Err(), errors.New("commit failed"))}
			}
			server := serveSearchWithTimeout(operation, &logs, 40*time.Millisecond)
			t.Cleanup(server.Close)
			t.Cleanup(func() { close(release) })
			status, body := postSearch(t, server, `{"query":"cache"}`)
			select {
			case err := <-expired:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("operation deadline=%v", err)
				}
			default:
				t.Fatal("operation did not observe its deadline")
			}
			if status != 500 || !strings.Contains(body, `"internal_error"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
				t.Fatalf("status=%d body=%s logs=%s", status, body, &logs)
			}
		})
	}
}

func TestSearchInputRejectsInvalidJSONFields(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"missing query", `{}`}, {"query type", `{"query":null}`}, {"assignedTo", `{"query":"x","assignedTo":null}`},
		{"status", `{"query":"x","status":true}`}, {"ready", `{"query":"x","ready":"true"}`},
		{"allowAgents", `{"query":"x","allowAgents":0}`}, {"platform", `{"query":"x","compatiblePlatform":[]}`},
		{"cursor", `{"query":"x","cursor":false}`}, {"limit null", `{"query":"x","limit":null}`},
		{"limit decimal", `{"query":"x","limit":1.0}`}, {"limit range", `{"query":"x","limit":101}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var fields map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tc.body), &fields); err != nil {
				t.Fatal(err)
			}
			if _, err := searchInput(fields); err == nil {
				t.Fatalf("accepted %s", tc.body)
			}
		})
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{"query":"cache","assignedTo":"me","status":"done","ready":true,"allowAgents":false,"compatiblePlatform":"linux","cursor":"token","limit":100}`), &fields); err != nil {
		t.Fatal(err)
	}
	input, err := searchInput(fields)
	if err != nil || input.AssignedTo == nil || *input.AssignedTo != "me" || input.Status == nil || *input.Status != model.TaskDone || input.Ready == nil || !*input.Ready || input.AllowAgents == nil || *input.AllowAgents || input.CompatiblePlatform == nil || *input.CompatiblePlatform != model.TaskPlatform("linux") || input.Cursor == nil || *input.Cursor != "token" || input.Limit != 100 {
		t.Fatalf("input=%+v err=%v", input, err)
	}
	fields = nil
	if err := json.Unmarshal([]byte(`{"query":"cache","cursor":null}`), &fields); err != nil {
		t.Fatal(err)
	}
	input, err = searchInput(fields)
	if err != nil || input.Cursor != nil || input.Limit != 50 {
		t.Fatalf("input=%+v err=%v", input, err)
	}
}

func TestSearchHTTPTagFilterParsingAndErrors(t *testing.T) {
	const filterTagA = "a1111111-a111-4111-8111-a11111111111"
	const filterTagB = "b2222222-b222-4222-8222-b22222222222"
	var logs bytes.Buffer
	calls := 0
	server := serveSearch(func(_ context.Context, _ model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if input.TagFilter.TagMatch == "invalid" {
			return tasksearch.Page{}, &model.Fault{Code: "invalid_tag_filter", Message: "Invalid tag filter."}
		}
		if len(input.TagFilter.TagIDs) != 2 || input.TagFilter.TagIDs[0] != filterTagA || input.TagFilter.TagIDs[1] != filterTagB || input.TagFilter.TagMatch != "any" || input.TagFilter.Untagged {
			t.Errorf("filter differs: %+v", input.TagFilter)
		}
		return tasksearch.Page{ProjectID: projectID, Items: []tasksearch.Item{}}, nil
	}, &logs)
	t.Cleanup(server.Close)
	status, body := postSearch(t, server, `{"query":"cache","tagIds":["`+filterTagA+`","`+filterTagB+`"],"tagMatch":"any","untagged":false}`)
	if status != 200 || calls != 1 || !strings.Contains(body, `"items":[]`) {
		t.Fatalf("status=%d body=%s calls=%d", status, body, calls)
	}
	for _, body := range []string{
		`{"query":"x","tagIds":null}`, `{"query":"x","tagIds":"x"}`,
		`{"query":"x","tagIds":[null]}`, `{"query":"x","tagMatch":null}`,
		`{"query":"x","untagged":"true"}`,
	} {
		status, result := postSearch(t, server, body)
		if status != 400 || calls != 1 || !strings.Contains(result, `"invalid_input"`) {
			t.Fatalf("body=%s status=%d result=%s calls=%d", body, status, result, calls)
		}
	}
	status, body = postSearch(t, server, `{"query":"x","tagMatch":"invalid"}`)
	if status != 400 || calls != 2 || !strings.Contains(body, `"invalid_tag_filter"`) {
		t.Fatalf("status=%d body=%s calls=%d", status, body, calls)
	}
}
