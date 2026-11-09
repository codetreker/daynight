package task

import (
	"errors"
	"fmt"
	"testing"

	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

func TestTaskStepsEncodingFaultPreservesCapacityAndOriginalCause(t *testing.T) {
	limit := &taskcodec.LimitError{EncodedBytes: taskcodec.MaxEncodedBytes + 1}
	for _, original := range []error{limit, fmt.Errorf("candidate encoding: %w", limit)} {
		converted := tasksteps.EncodingFault(original)
		fault, pure := TaskStepsFault(converted)
		if !pure || fault.Code != "steps_limit_exceeded" || fault.Message == "" || fault.StepsLimit == nil || fault.StepsLimit.EncodedBytes != taskcodec.MaxEncodedBytes+1 || fault.StepsLimit.MaxEncodedBytes != taskcodec.MaxEncodedBytes {
			t.Fatalf("capacity refusal lost its public details: %#v", converted)
		}
		var actual *taskcodec.LimitError
		if fault.Cause != original || !errors.Is(converted, original) || !errors.Is(converted, limit) || !errors.As(converted, &actual) || actual != limit {
			t.Fatal("capacity conversion lost the original encoding error chain")
		}
	}
	failure := errors.New("unrelated encoding failure")
	for _, original := range []error{failure, fmt.Errorf("candidate encoding: %w", failure)} {
		converted := tasksteps.EncodingFault(original)
		if converted != original || !errors.Is(converted, failure) {
			t.Fatal("unrelated encoding error was replaced or unwrapped")
		}
		if _, pure := TaskStepsFault(converted); pure {
			t.Fatal("unrelated encoding failure became a business refusal")
		}
	}
}
