package operation

import (
	"errors"
	"fmt"
	"testing"

	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestKnownFaultPropertyValidationAndMixedErrors(t *testing.T) {
	first := &taskproperty.ValidationError{Path: "paused", Rule: "paused must be a boolean"}
	second := &taskproperty.ValidationError{Path: "worker", Rule: "worker is invalid"}
	for _, tc := range []struct {
		name  string
		err   error
		known bool
	}{
		{"single", first, true},
		{"wrapped", fmt.Errorf("validate: %w", first), true},
		{"joined validations", errors.Join(first, fmt.Errorf("wrapped: %w", second)), true},
		{"validation and I/O failure", errors.Join(first, errors.New("storage failed")), false},
		{"unrelated failure", errors.New("storage failed"), false},
		{"nil", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fault, ok := KnownFault(tc.err)
			if ok != tc.known {
				t.Fatalf("known=%v, fault=%#v", ok, fault)
			}
			if ok && (fault.Code != "invalid_input" || fault.Message != first.Rule) {
				t.Fatalf("fault=%#v", fault)
			}
		})
	}
}
