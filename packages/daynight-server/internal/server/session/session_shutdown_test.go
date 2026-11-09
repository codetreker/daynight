package session_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type sessionHTTPShutdown struct {
	expectShutdownError func(error) bool
}

func (s *sessionHTTPShutdown) register(t *testing.T, shutdown func(context.Context) error) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := shutdown(ctx); err != nil && (s.expectShutdownError == nil || !s.expectShutdownError(err)) {
			t.Error(err)
		}
	})
}

func shutdownFaultMatches(err error, code string) bool {
	if drained, ok := err.(interface {
		Drained() bool
		Unwrap() error
	}); ok && drained.Drained() {
		return shutdownFaultMatches(drained.Unwrap(), code)
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range joined.Unwrap() {
			if !shutdownFaultMatches(cause, code) {
				return false
			}
		}
		return len(joined.Unwrap()) > 0
	}
	fault, ok := err.(*model.Fault)
	return code != "" && ok && fault.Code == code && fault.Cause == nil
}

type fixtureDrainError struct {
	cause   error
	drained bool
}

func (e fixtureDrainError) Error() string { return e.cause.Error() }
func (e fixtureDrainError) Unwrap() error { return e.cause }
func (e fixtureDrainError) Drained() bool { return e.drained }

func TestSessionShutdownReadsCurrentExpectation(t *testing.T) {
	fixture := sessionHTTPShutdown{}
	shutdownCalls, expectationCalls := 0, 0
	t.Run("cleanup", func(t *testing.T) {
		fixture.register(t, func(ctx context.Context) error {
			shutdownCalls++
			if _, ok := ctx.Deadline(); !ok || ctx.Err() != nil {
				t.Fatal("shutdown did not receive a live bounded context")
			}
			return fixtureDrainError{cause: &model.Fault{Code: "not_found"}, drained: true}
		})
		fixture.expectShutdownError = func(err error) bool {
			expectationCalls++
			return shutdownFaultMatches(err, "not_found")
		}
	})
	if shutdownCalls != 1 || expectationCalls != 1 {
		t.Fatalf("cleanup calls: shutdown=%d expectation=%d", shutdownCalls, expectationCalls)
	}
}

func TestSessionShutdownFaultExpectationRejectsUnexpectedCauses(t *testing.T) {
	missing := &model.Fault{Code: "not_found"}
	storageFailure := errors.New("injected disconnect failure")
	completed := func(err error) error { return fixtureDrainError{cause: err, drained: true} }
	for _, test := range []struct {
		name string
		err  error
		code string
		want bool
	}{
		{"domain refusal", missing, "not_found", true},
		{"completed drain", completed(missing), "not_found", true},
		{"joined expected refusals", completed(errors.Join(missing, missing)), "not_found", true},
		{"nested expected drains", completed(errors.Join(missing, completed(missing))), "not_found", true},
		{"mixed storage failure", completed(errors.Join(missing, storageFailure)), "not_found", false},
		{"mixed timeout", completed(errors.Join(missing, context.DeadlineExceeded)), "not_found", false},
		{"mixed domain refusal", completed(errors.Join(missing, &model.Fault{Code: "unauthenticated"})), "not_found", false},
		{"fault retains storage cause", completed(&model.Fault{Code: "not_found", Cause: storageFailure}), "not_found", false},
		{"incomplete drain", fixtureDrainError{cause: missing}, "not_found", false},
		{"unexpected storage failure", completed(storageFailure), "not_found", false},
		{"no error", nil, "not_found", false},
		{"no selected fault", missing, "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := shutdownFaultMatches(test.err, test.code); got != test.want {
				t.Fatalf("expected fault %q matched=%t, want %t: %v", test.code, got, test.want, test.err)
			}
		})
	}
}
