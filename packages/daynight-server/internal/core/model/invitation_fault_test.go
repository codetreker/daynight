package model

import (
	"errors"
	"testing"
)

func TestInvitationUnavailable(t *testing.T) {
	cause := errors.New("lookup failed")
	err := InvitationUnavailable(cause)
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || fault.Message != "Invitation is unavailable." || !errors.Is(err, cause) {
		t.Fatalf("unexpected invitation refusal: %#v", err)
	}
}
