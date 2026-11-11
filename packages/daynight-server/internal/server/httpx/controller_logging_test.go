package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestControllerFailureLoggingRedactsUntrustedStorePhase(t *testing.T) {
	for _, phase := range []string{"controller_connect", "controller_source", "controller_fence", "controller_handle", "controller_poll"} {
		t.Run(phase, func(t *testing.T) {
			var logs bytes.Buffer
			LogFailure(slog.New(slog.NewJSONHandler(&logs, nil)), context.Background(), "session", phase, &store.Error{Phase: "PRIVATE-PHASE-CANARY", Cause: errors.New("PRIVATE-CAUSE-CANARY")})
			var entry map[string]any
			if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
				t.Fatal(err)
			}
			if strings.Contains(logs.String(), "CANARY") || entry["phase"] != phase || entry["cause"] != "database" || entry["error_code"] != "internal_error" {
				t.Fatalf("unsafe controller diagnostic: %s", logs.String())
			}
		})
	}
}

func TestControllerLoggingRetainsAdapterPhaseAndDomainCode(t *testing.T) {
	var logs bytes.Buffer
	failure := &RuntimeError{Component: "PRIVATE-COMPONENT-CANARY", Phase: "PRIVATE-PHASE-CANARY", Cause: &model.Fault{Code: "not_found", Message: "PRIVATE-MESSAGE-CANARY"}}
	LogFailure(slog.New(slog.NewJSONHandler(&logs, nil)), context.Background(), "session", "controller_handle", failure)
	var entry map[string]any
	if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logs.String(), "CANARY") || entry["component"] != "session" || entry["phase"] != "controller_handle" || entry["cause"] != "not_found" || entry["error_code"] != "not_found" {
		t.Fatalf("unsafe or unclassified diagnostic: %s", logs.String())
	}
}

func TestControllerLoggingDoesNotChangeOtherScopes(t *testing.T) {
	for _, scope := range [][2]string{{"session", "channel"}, {"other", "controller_handle"}} {
		var logs bytes.Buffer
		LogFailure(slog.New(slog.NewJSONHandler(&logs, nil)), context.Background(), scope[0], scope[1], &RuntimeError{Component: "runtime_component", Phase: "runtime_phase", Cause: errors.New("private")})
		var entry map[string]any
		if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["component"] != "runtime_component" || entry["phase"] != "runtime_phase" || entry["diagnostic"] != "HTTP runtime_phase failed" {
			t.Fatalf("unrelated diagnostic changed: %+v", entry)
		}
	}
}
