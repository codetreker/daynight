package bot

import (
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type callbackExpectation struct {
	cause      error
	freshFault *model.Fault
}

func callbackCause(cause error) callbackExpectation {
	return callbackExpectation{cause: cause}
}

func callbackFreshFault(fault *model.Fault) callbackExpectation {
	if fault == nil {
		panic("fresh callback fault must be non-nil")
	}
	return callbackExpectation{freshFault: fault}
}

func (e callbackExpectation) check(t *testing.T, actual error) {
	t.Helper()
	if e.freshFault == nil {
		if !errors.Is(actual, e.cause) {
			t.Fatalf("callback did not retain the supplied cause: got %#v, want %#v", actual, e.cause)
		}
		return
	}
	var fault *model.Fault
	if !errors.As(actual, &fault) {
		t.Fatalf("callback did not return the expected generated fault: got %#v", actual)
	}
	if !errors.Is(fault.Cause, e.freshFault.Cause) {
		t.Fatalf("generated callback fault did not retain its cause: got %#v, want %#v", fault.Cause, e.freshFault.Cause)
	}
	got, want := *fault, *e.freshFault
	got.Cause, want.Cause = nil, nil
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("generated callback fault changed its fields: got %#v, want %#v", got, want)
	}
}
