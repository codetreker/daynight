package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	short bool
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) {
	w.calls++
	if w.short {
		return 0, nil
	}
	return 0, errors.New("private response failure")
}

func TestThreadHTTPFailurePriorityAndResponseWrite(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest(http.MethodPost, "/thread/messages", nil)
	request.Header.Set("X-Request-ID", "project-test")
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "message_not_found", Message: "message not found"}, 404, "message_not_found"},
		{&model.Fault{Code: "clock_not_advanced", Message: "Clock unavailable"}, 503, "clock_not_advanced"},
		{&model.Fault{Code: "payload_too_large", Message: "Message too large"}, 413, "payload_too_large"},
		{&service.ThreadMessageError{MessageID: "candidate", Cause: &store.ThreadTransactionError{Phase: "callback", Cause: &store.ThreadClockError{Cause: context.DeadlineExceeded}}}, 503, "clock_not_advanced"},
		{&store.ThreadTransactionError{Phase: "commit", CommitAttempted: true, OutcomeUnknown: true, Cause: context.DeadlineExceeded}, 503, "message_outcome_unknown"},
		{&store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true, Cause: &model.Fault{Code: "invalid_input", Message: "private business refusal"}}, 500, "internal_error"},
	} {
		recorder := httptest.NewRecorder()
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeThreadError(w, r, logger, "append", test.err)
		})).ServeHTTP(recorder, request)
		var body api.ErrorResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || recorder.Code != test.status || body.Error.Code != test.code {
			t.Fatalf("error response: %d %s", recorder.Code, recorder.Body.String())
		}
	}
	if !strings.Contains(logs.String(), `"write_outcome":"unknown"`) || !strings.Contains(logs.String(), `"cause":"deadline"`) {
		t.Fatal("unknown commit lost its causal classification")
	}
	if strings.Contains(logs.String(), "private business refusal") || !strings.Contains(logs.String(), `"phase":"rollback","cause":"internal","error_code":"internal_error"`) || !strings.Contains(logs.String(), `"message_id":"candidate"`) {
		t.Fatal("cleanup failure lost precedence or safe candidate correlation")
	}
	for _, short := range []bool{false, true} {
		writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		writeThreadJSON(writer, request, logger, http.StatusCreated, []byte(`{"id":"committed"}`))
		if writer.calls != 1 || writer.Code != http.StatusCreated || strings.Contains(logs.String(), "private response failure") {
			t.Fatal("response failure retried or leaked an error")
		}
	}
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	recorder := httptest.NewRecorder()
	writeThreadJSON(recorder, request.WithContext(ctx), logger, http.StatusCreated, []byte(`{}`))
	if recorder.Body.Len() != 0 || recorder.Header().Get("Content-Type") != "" {
		t.Fatal("canceled response was written")
	}
}
