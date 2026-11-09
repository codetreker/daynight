package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestTaskOperationHTTPReturnsHistoricalBindingAndUnknownAbsence(t *testing.T) {
	f := sessionHTTPSetup(t)
	operation := uuid.NewString()
	path := f.base + "/" + f.snapshot.SessionID + "/operations/" + operation
	supplied := core.TaskOperationResult{Operation: sp.Operation{Fence: f.snapshot.Fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", State: "unknown"}, CurrentBinding: false}
	missing := false
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TaskOperation = func(ctx context.Context, p model.Principal, project, task, id, actual string) (core.TaskOperationResult, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return core.TaskOperationResult{}, err
			}
			if actual != operation {
				t.Fatal("historical operation changed")
			}
			if missing {
				return core.TaskOperationResult{}, &model.Fault{Code: "not_found", Message: "Operation was not found."}
			}
			return supplied, nil
		}
	})
	f.nextCall("TaskOperation")
	got := decodeResponse[core.TaskOperationResult](t, projectRequest(f.handler, http.MethodGet, path, ""), http.StatusOK)
	if !reflect.DeepEqual(got, supplied) {
		t.Fatalf("history response changed: %#v", got)
	}
	missing = true
	f.nextCall("TaskOperation")
	assertProjectError(t, projectRequest(f.handler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
}

func TestTaskSendHTTPRetains202LocationAndExactBodyLimit(t *testing.T) {
	f := sessionHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID + "/commands"
	command := sp.Command{Fence: f.snapshot.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), RequestID: "one", Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"/literal\r\n消息😀\n"}],"expectedTurnId":null}`)}
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Submit = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Command) (sp.Operation, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.Operation{}, err
			}
			if !reflect.DeepEqual(actual, command) {
				t.Fatal("HTTP changed exact text or fence")
			}
			return sp.Operation{Fence: actual.Fence, Protocol: sp.Protocol, OperationID: actual.OperationID, Kind: actual.Kind, State: "accepted"}, nil
		}
	})
	raw := jsonBody(t, command)
	f.nextCall("Submit")
	response := projectRequest(f.handler, http.MethodPost, path, raw+strings.Repeat(" ", sp.MaxFrameBytes-len(raw)))
	if response.Code != http.StatusAccepted || response.Header().Get("Location") != f.base+"/"+f.snapshot.SessionID+"/operations/"+command.OperationID {
		t.Fatalf("submission status/location: %d %#v %s", response.Code, response.Header(), response.Body)
	}
	calls := f.backend.TotalCalls()
	for _, bad := range []string{raw + strings.Repeat(" ", sp.MaxFrameBytes-len(raw)+1), strings.Replace(raw, `/literal`, `\ud800`, 1), strings.Replace(raw, `/literal`, `\u0000`, 1), `{}`} {
		response := projectRequest(f.handler, http.MethodPost, path, bad)
		if response.Code != http.StatusBadRequest && response.Code != http.StatusRequestEntityTooLarge || f.backend.TotalCalls() != calls {
			t.Fatalf("invalid command reached Submit: %d %s", response.Code, response.Body)
		}
	}
}

func TestTaskOperationHTTPCancellationReachesUseCaseOnce(t *testing.T) {
	f := sessionHTTPSetup(t)
	operation := uuid.NewString()
	started := make(chan struct{})
	finished := make(chan struct{})
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TaskOperation = func(ctx context.Context, p model.Principal, project, task, id, actual string) (core.TaskOperationResult, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return core.TaskOperationResult{}, err
			}
			if actual != operation {
				t.Error("operation changed")
			}
			close(started)
			<-ctx.Done()
			return core.TaskOperationResult{}, ctx.Err()
		}
	})
	f.nextCall("TaskOperation")
	f.authentication.ExpectCalls(1)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, f.base+"/"+f.snapshot.SessionID+"/operations/"+operation, nil).WithContext(ctx)
	authorizeResourceRequest(f.handler, request)
	go func() { defer close(finished); f.handler.ServeHTTP(httptest.NewRecorder(), request) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("read did not stop")
	}
	if f.backend.Called("TaskOperation") != 1 {
		t.Fatal("cancellation repeated operation read")
	}
}
