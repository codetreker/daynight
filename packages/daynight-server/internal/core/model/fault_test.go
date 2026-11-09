package model

import (
	"errors"
	"fmt"
	"testing"
)

func TestFaultPreservesMessageDetailsAndCause(t *testing.T) {
	cause := errors.New("underlying failure")
	fault := &Fault{
		Code:       "steps_limit_exceeded",
		Message:    "steps limit exceeded",
		Cause:      cause,
		TaskIDs:    []string{"task-1"},
		StepsLimit: &StepsLimitDetails{EncodedBytes: 9, MaxEncodedBytes: 8},
	}
	if got := fault.Error(); got != "steps limit exceeded" {
		t.Fatalf("Error() = %q", got)
	}
	wrapped := fmt.Errorf("operation failed: %w", fault)
	var found *Fault
	if !errors.As(wrapped, &found) || found != fault || !errors.Is(wrapped, cause) {
		t.Fatalf("fault or cause lost from error chain: %v", wrapped)
	}
	if found.Code != "steps_limit_exceeded" || found.TaskIDs[0] != "task-1" || *found.StepsLimit != (StepsLimitDetails{9, 8}) {
		t.Fatalf("fault details changed: %+v", found)
	}
	if errors.Unwrap(&Fault{Message: "no cause"}) != nil {
		t.Fatal("fault without a cause must unwrap to nil")
	}
}

func TestIdentityProviderErrorMessageAndCause(t *testing.T) {
	cause := errors.New("provider failure")
	for _, tc := range []struct{ code, message string }{
		{"identity_configuration", "The identity provider configuration is unavailable."},
		{"identity_timeout", "The identity provider request timed out."},
		{"identity_unavailable", "The identity provider is unavailable."},
		{"unknown", "The identity provider is unavailable."},
	} {
		t.Run(tc.code, func(t *testing.T) {
			failure := &IdentityProviderError{Code: tc.code, Cause: cause}
			if got := failure.Error(); got != tc.message {
				t.Fatalf("Error() = %q, want %q", got, tc.message)
			}
			wrapped := fmt.Errorf("provider: %w", failure)
			var found *IdentityProviderError
			if !errors.Is(wrapped, cause) || !errors.As(wrapped, &found) || found != failure {
				t.Fatalf("provider error or cause lost from error chain: %v", wrapped)
			}
		})
	}
}

func TestBotOperationErrorMessageAndCause(t *testing.T) {
	cause := errors.New("storage failed")
	failure := &BotOperationError{Operation: "delete", Cause: cause}
	if got := failure.Error(); got != "delete bot: storage failed" {
		t.Fatalf("Error() = %q", got)
	}
	wrapped := fmt.Errorf("request: %w", failure)
	var found *BotOperationError
	if !errors.Is(wrapped, cause) || !errors.As(wrapped, &found) || found != failure {
		t.Fatalf("bot error or cause lost from error chain: %v", wrapped)
	}
}

func TestTaskDeletedWrapsNotFound(t *testing.T) {
	if !errors.Is(ErrTaskDeleted, ErrNotFound) || errors.Is(ErrNotFound, ErrTaskDeleted) {
		t.Fatal("task deletion must retain its distinct identity and wrap ErrNotFound")
	}
	if !errors.Is(fmt.Errorf("lookup: %w", ErrTaskDeleted), ErrTaskDeleted) {
		t.Fatal("wrapped task deletion lost its error identity")
	}
}
