package store

import (
	"errors"
	"strings"
	"testing"
)

func TestWebhookAdmissionEventErrorRetainsCauseWithoutExposingDetails(t *testing.T) {
	cause := errors.New("private destination and payload")
	err := &WebhookAdmissionEventError{Cause: cause}
	if !errors.Is(err, cause) || err.Error() != "webhook admission event unavailable" || strings.Contains(err.Error(), cause.Error()) {
		t.Fatalf("unsafe or untraceable error: %v", err)
	}
}
