package task

import (
	"context"
	"errors"
	"fmt"
	"testing"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestPropertyInputFaultPreservesFailureCategory(t *testing.T) {
	operational := fmt.Errorf("property operation: %w", context.Canceled)
	if actual := taskcore.PropertyInputError(operational); actual != operational {
		t.Fatalf("operational failure changed identity: %v", actual)
	}
	cause := errors.New("invalid stored syntax")
	invalid := &taskproperties.ValidationError{Path: "properties.pullRequests", Rule: "properties.pullRequests must be an array", Cause: cause}
	wrapped := fmt.Errorf("read property: %w", invalid)
	var fault *model.Fault
	if err := taskcore.PropertyInputError(wrapped); !errors.As(err, &fault) || fault.Code != "invalid_input" || fault.Message != invalid.Rule || !errors.Is(err, cause) || !errors.Is(err, wrapped) {
		t.Fatalf("property validation lost diagnostic or cause: %#v", err)
	}
}
