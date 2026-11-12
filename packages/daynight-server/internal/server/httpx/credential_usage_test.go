package httpx

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

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func requestUsageFault(ctx context.Context) usage.Fault {
	now := time.Date(2026, 11, 12, 0, 0, 0, 123000, time.UTC)
	return usage.Fault{Phase: usage.PhaseSubmit, Code: usage.CodeQueueFull, Cause: usage.CauseCapacity,
		Observation: usage.Observation{Event: model.CredentialUsageEvent{Kind: model.UsageSubjectPAT,
			UserID: "11111111-1111-4111-8111-111111111111", SubjectID: "22222222-2222-4222-8222-222222222222", At: now},
			RequestID: RequestID(ctx), Source: usage.SourceHTTPPAT}, OccurredAt: now, Depth: usage.ResidentLimit}
}

func TestCredentialUsagePublicationBeforeLongHandlerReturns(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	published, release, done := make(chan struct{}), make(chan struct{}, 1), make(chan struct{})
	defer close(release)
	handler := RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		collector := usage.CollectorFrom(r.Context())
		if collector == nil || collector.Record(requestUsageFault(r.Context())) != nil {
			t.Error("request collector unavailable or fault rejected")
			return
		}
		if err := PublishCredentialUsageFaults(logger, r.Context()); err != nil {
			t.Error(err)
		}
		close(published)
		<-release
		w.WriteHeader(http.StatusForbidden)
	}))
	request := httptest.NewRequest("GET", "/?secret=query", strings.NewReader("secret=body"))
	request.Header.Set("X-Request-ID", "usage-request")
	go func() { defer close(done); handler.ServeHTTP(httptest.NewRecorder(), request) }()
	select {
	case <-published:
	case <-time.After(5 * time.Second):
		t.Fatal("publication blocked before business handling")
	}
	select {
	case <-done:
		t.Fatal("handler returned before release")
	default:
	}
	var record map[string]any
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	fault := record["credential_usage"].(map[string]any)
	if record["request_id"] != "usage-request" || record["component"] != "server" || fault["subject_id"] != "22222222-2222-4222-8222-222222222222" || fault["user_id"] != "11111111-1111-4111-8111-111111111111" || fault["phase"] != "submit" || fault["error_code"] != "queue_full" {
		t.Fatalf("unqueryable fault: %+v", record)
	}
	release <- struct{}{}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return")
	}
	if strings.Count(output.String(), `"credential_usage":{`) != 1 || strings.Contains(output.String(), "secret") || !strings.Contains(output.String(), `"status":403`) {
		t.Fatalf("duplicate, unsafe or altered completion: %s", &output)
	}
}

func TestCredentialUsageFallbackPreservesRequestExit(t *testing.T) {
	for _, outcome := range []string{"returned", "panic", "aborted"} {
		for _, early := range []bool{false, true} {
			t.Run(outcome+"/"+map[bool]string{false: "fallback", true: "early"}[early], func(t *testing.T) {
				var output bytes.Buffer
				logger := slog.New(slog.NewJSONHandler(&output, nil))
				handler := RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if err := usage.CollectorFrom(r.Context()).Record(requestUsageFault(r.Context())); err != nil {
						t.Fatal(err)
					}
					if early {
						if err := PublishCredentialUsageFaults(logger, r.Context()); err != nil {
							t.Fatal(err)
						}
					}
					switch outcome {
					case "panic":
						panic("secret panic content")
					case "aborted":
						panic(http.ErrAbortHandler)
					}
					w.WriteHeader(http.StatusNoContent)
				}))
				var recovered any
				func() {
					defer func() { recovered = recover() }()
					handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
				}()
				if outcome == "returned" && recovered != nil || outcome != "returned" && recovered != http.ErrAbortHandler {
					t.Fatalf("changed exit: %v", recovered)
				}
				if strings.Count(output.String(), `"credential_usage":{`) != 1 || strings.Contains(output.String(), "secret") {
					t.Fatalf("missing, duplicate or unsafe fault: %s", &output)
				}
				if outcome == "aborted" && !strings.Contains(output.String(), `"cause":"aborted"`) {
					t.Fatalf("missing aborted request log: %s", &output)
				}
			})
		}
	}
}

type usagePublicationHandler struct {
	slog.Handler
	before func() error
}

func (h usagePublicationHandler) Handle(ctx context.Context, r slog.Record) error {
	if err := h.before(); err != nil {
		return err
	}
	return h.Handler.Handle(ctx, r)
}

func TestCredentialUsagePublicationAcknowledgesOnlySuccessfulRevision(t *testing.T) {
	var collector usage.Collector
	ctx := usage.WithCollector(context.Background(), &collector)
	fault := requestUsageFault(ctx)
	fault.Observation.RequestID = "revision-request"
	if err := collector.Record(fault); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	sinkFailure := errors.New("controlled sink failure")
	logger := slog.New(usagePublicationHandler{Handler: slog.NewJSONHandler(&output, nil), before: func() error { return sinkFailure }})
	if err := PublishCredentialUsageFaults(logger, ctx); !errors.Is(err, sinkFailure) {
		t.Fatal(err)
	}
	if _, pending := collector.Snapshot(); !pending {
		t.Fatal("failed logging acknowledged revision")
	}
	logger = slog.New(usagePublicationHandler{Handler: slog.NewJSONHandler(&output, nil), before: func() error {
		fault.Phase, fault.Code, fault.Cause = usage.PhaseRotation, usage.CodeRotationOutcomeUnknown, usage.CauseUnknown
		return collector.Record(fault)
	}})
	if err := PublishCredentialUsageFaults(logger, ctx); err != nil {
		t.Fatal(err)
	}
	if summary, pending := collector.Snapshot(); !pending || summary.Revision != 2 {
		t.Fatal("old publication cleared a newer revision")
	}
	logger = slog.New(slog.NewJSONHandler(&output, nil))
	if err := PublishCredentialUsageFaults(logger, ctx); err != nil {
		t.Fatal(err)
	}
	if _, pending := collector.Snapshot(); pending {
		t.Fatal("successful revision not acknowledged")
	}
	length := output.Len()
	if err := PublishCredentialUsageFaults(logger, ctx); err != nil || output.Len() != length {
		t.Fatal("healthy collector produced a log")
	}
	if err := PublishCredentialUsageFaults(logger, context.Background()); !errors.Is(err, ErrCredentialUsageObservation) {
		t.Fatal("missing collector was silently ignored")
	}
	if err := PublishCredentialUsageFaults(nil, ctx); !errors.Is(err, ErrCredentialUsageObservation) {
		t.Fatal("missing logger was silently ignored")
	}
	if err := PublishCredentialUsageFaults(logger, nil); !errors.Is(err, ErrCredentialUsageObservation) {
		t.Fatal("missing context was silently ignored")
	}
}
