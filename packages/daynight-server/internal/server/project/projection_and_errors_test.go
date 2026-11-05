package project

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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
)

func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}

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

func TestProjectGrantErrorTransactionOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"unknown commit", &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{"unknown cleanup", &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: &model.Fault{Code: "version_conflict", Message: "private"}}, 503, "write_outcome_unknown"},
		{"confirmed rollback", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "version_conflict", Message: "version conflict"}}, 409, "version_conflict"},
		{"known rollback with cleanup failure", &store.TransactionError{Phase: "cleanup", CommitAttempted: true, CleanupFailed: true, Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "version_conflict", Message: "private"}}, 500, "internal_error"},
		{"database failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.New("private")}, 500, "internal_error"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			w := httptest.NewRecorder()
			r := httptest.NewRequest("PUT", "/", nil)
			r.Header.Set("X-Request-ID", "project-test")
			httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeGrantError(w, r, logger, "set", time.Now(), tc.err)
			})).ServeHTTP(w, r)
			assertProjectError(t, w, tc.status, tc.code)
			if strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), `"component":"project_grant"`) {
				t.Fatalf("unsafe or unscoped log: %s", logs.String())
			}
		})
	}
}

func TestProjectGrantVersionDecoderExact(t *testing.T) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{"version":9007199254740993}`), &fields); err != nil {
		t.Fatal(err)
	}
	v, err := grantVersion(fields)
	if err != nil || v == nil || *v != 9007199254740993 {
		t.Fatalf("exact version: %v %v", v, err)
	}
}

func TestProjectGrantResponseWriteFailureIsNotRetried(t *testing.T) {
	for _, short := range []bool{false, true} {
		var logs bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		request := httptest.NewRequest(http.MethodPut, "/", nil)
		writeGrantJSON(writer, request, logger, time.Now(), api.RemoveProjectGrantResult{Deleted: true})
		if writer.calls != 1 || writer.Code != 200 || strings.Contains(logs.String(), "private response failure") || !strings.Contains(logs.String(), `"phase":"response"`) || !strings.Contains(logs.String(), `"outcome":"unknown"`) || strings.Count(logs.String(), `"msg":"operation failed"`) != 1 {
			t.Fatalf("response failure: calls=%d status=%d log=%s", writer.calls, writer.Code, logs.String())
		}
	}
}

// A database timestamp outside JSON's year range makes a committed receipt
// impossible to encode; this is an unknown client outcome rather than success.

func TestProjectGrantResponseEncodingFailure(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/", nil)
	r.Header.Set("X-Request-ID", "project-test")
	httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := api.ProjectGrantResult{Grant: api.ProjectGrant{CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}}
		writeGrantJSON(w, r, logger, time.Now(), result)
	})).ServeHTTP(w, r)
	assertProjectError(t, w, http.StatusServiceUnavailable, "write_outcome_unknown")
	if !strings.Contains(logs.String(), `"outcome":"unknown"`) || !strings.Contains(logs.String(), `"phase":"response"`) {
		t.Fatalf("missing response classification: %s", logs.String())
	}
}

func TestProjectGrantCanceledResponseDoesNotWrite(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodDelete, "/", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	writeGrantJSON(w, r, logger, time.Now(), api.RemoveProjectGrantResult{Deleted: true})
	if w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"outcome":"unknown"`) {
		t.Fatalf("canceled response wrote data or lost classification: %s", logs.String())
	}
}

func TestInvitationUnknownTransactionOutcomeIsExplicitAndSafe(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	cause := errors.New("secret database diagnostic")
	err := &store.TransactionError{Phase: "commit", Cause: cause, Outcome: store.TransactionUnknown, CommitAttempted: true}
	response := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/", nil)
	request.Header.Set("X-Request-ID", "project-test")
	httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		invitationWriteError(w, r, logger, "accept_invitation", err)
	})).ServeHTTP(response, request)
	assertProjectError(t, response, 503, "write_outcome_unknown")
	if response.Header().Get("X-Request-ID") != "project-test" || !strings.Contains(response.Body.String(), `"requestId":"project-test"`) {
		t.Fatal("unknown write lost its request correlation")
	}
	if !errors.Is(err, cause) || strings.Contains(response.Body.String(), cause.Error()) || strings.Contains(logs.String(), cause.Error()) {
		t.Fatal("unknown write disclosed or lost its underlying cause")
	}
}

func TestInvitationInspectRejectsMalformedJSONWithoutDisclosingToken(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	routes := &MembershipRoutes{logger: logger}
	for _, body := range []string{`{"token":"secret","extra":true}`, `{"token":"secret","token":"second"}`, `{"token":"secret"`} {
		request := httptest.NewRequest("POST", "/api/v1/invitations/inspect", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			routes.inspectInvitation(w, r, model.Principal{})
		})).ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if strings.Contains(response.Body.String(), "secret") || strings.Contains(logs.String(), "secret") {
			t.Fatal("malformed inspection disclosed the token")
		}
	}
}

func TestProjectParticipantDTOKeepsSourcesIndependent(t *testing.T) {
	grant := model.ProjectGrant{ProjectID: "project", UserID: "user", Role: model.ProjectMemberRole, Version: 9007199254740993}
	participant := participantResponse(model.ProjectParticipant{UserID: "user", EffectiveRole: model.ProjectAdmin, DirectGrant: &grant})
	if participant.EffectiveRole != "admin" || participant.DirectGrant == nil || participant.DirectGrant.Role != "member" || participant.DirectGrant.Version != grant.Version {
		t.Fatalf("effective role overwrote a direct grant: %#v", participant)
	}
	participant = participantResponse(model.ProjectParticipant{UserID: "user", EffectiveRole: model.ProjectMemberRole})
	encoded, err := json.Marshal(participant)
	if err != nil || !strings.Contains(string(encoded), `"directGrant":null`) || !strings.Contains(string(encoded), `"profile":{"name":null,"email":null,"avatarUrl":null}`) {
		t.Fatalf("nullable grant model invented a stored row: %s %v", encoded, err)
	}
}

func TestProjectCreateUnknownOutcomeClassification(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects", nil)
	request.Header.Set("X-Request-ID", "project-test")
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: &model.Fault{Code: "forbidden", Message: "private"}}, 500, "internal_error"},
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionNotCommitted, Cause: errors.New("private")}, 500, "internal_error"},
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, 404, "not_found"},
	} {
		response := httptest.NewRecorder()
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeProjectCreateError(w, r, logger, test.err) })).ServeHTTP(response, request)
		assertProjectError(t, response, test.status, test.code)
	}
	for _, short := range []bool{false, true} {
		writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		httpx.WriteMutationJSON(writer, request, logger, "project", 201, api.ProjectDocument{})
		if writer.calls != 1 {
			t.Fatal("response replayed")
		}
	}
	if strings.Contains(logs.String(), "private") {
		t.Fatal("private errors leaked")
	}
}

func TestTransferHTTPCompletionClassification(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest("POST", "/api/v1/projects/transfer", nil)
	request.Header.Set("X-Request-ID", "project-test")
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, 404, "not_found"},
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "version_conflict", Message: "changed"}}, 409, "version_conflict"},
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "cleanup", CommitAttempted: true, CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: errors.Join(context.DeadlineExceeded, errors.New("private cleanup"))}, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Cause: &model.Fault{Code: "forbidden", Message: "private refusal"}}, 500, "internal_error"},
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionNotCommitted, Cause: errors.New("private error")}, 500, "internal_error"},
	} {
		w := httptest.NewRecorder()
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeTransferError(w, r, logger, time.Now(), "operation", tc.err)
		})).ServeHTTP(w, request)
		assertProjectError(t, w, tc.status, tc.code)
	}
	for _, short := range []bool{false, true} {
		w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		writeTransferJSON(w, request, logger, time.Now(), api.TransferReceipt{})
		if w.calls != 1 {
			t.Fatal("response replayed")
		}
	}
	w := httptest.NewRecorder()
	writeTransferJSON(w, request, logger, time.Now(), func() {})
	var body api.ErrorResponse
	if w.Code != 503 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Error.Code != "write_outcome_unknown" {
		t.Fatalf("marshal failure: %s", w.Body)
	}
	if strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), `"outcome":"unknown"`) || !strings.Contains(logs.String(), `"error_code":"write_outcome_unknown"`) {
		t.Fatalf("unsafe or unclassified log: %s", &logs)
	}
}

func TestTransferCanceledResponseIsNotWritten(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	writeTransferJSON(w, r, logger, time.Now(), api.TransferReceipt{})
	if w.Body.Len() != 0 || w.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"outcome":"unknown"`) {
		t.Fatalf("canceled response wrote data or lost classification: %s", logs.String())
	}
}
