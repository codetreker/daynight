package completion

import (
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestCapture(t *testing.T) {
	fault := &model.Fault{Code: "forbidden", Message: "Access denied."}
	failure := errors.New("storage failed")
	for _, tc := range []struct {
		name         string
		operationErr error
		wantErr      error
		wantRefusal  *model.Fault
	}{
		{name: "success"},
		{name: "refusal", operationErr: fault, wantRefusal: fault},
		{name: "wrapped refusal", operationErr: fmt.Errorf("operation: %w", fault), wantRefusal: fault},
		{name: "ordinary error", operationErr: failure, wantErr: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var refusal *model.Fault
			calls := 0
			err := Capture(func() error {
				calls++
				return tc.operationErr
			}, &refusal)
			if calls != 1 || err != tc.wantErr || refusal != tc.wantRefusal {
				t.Fatalf("calls=%d, error=%v, refusal=%v", calls, err, refusal)
			}
		})
	}
}
