package attachment

import (
	"errors"
	"testing"
)

func TestFileEffectErrorRetainsDiagnosticAndCause(t *testing.T) {
	cause := errors.New("delete failed")
	err := &fileEffectError{cause: cause}
	if err.Error() != cause.Error() || !errors.Is(err, cause) || !FileEffectPossible(err) {
		t.Fatalf("file effect error: %v", err)
	}
}
