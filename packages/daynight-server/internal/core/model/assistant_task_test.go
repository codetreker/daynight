package model

import (
	"errors"
	"testing"
)

func TestAssistantClaimErrorPreservesDomainFaultAndCause(t *testing.T) {
	cause := errors.New("original failure")
	fault := &Fault{Code: "claim_held", Message: "An assistant holds this task.", Cause: cause}
	err := &AssistantTaskClaimError{Fault: fault, Claim: AssistantTaskClaim{State: "active", Generation: 4}}
	var domain *Fault
	if err.Error() != fault.Message || !errors.As(err, &domain) || domain != fault || !errors.Is(err, cause) {
		t.Fatalf("claim details lost the original fault: %v", err)
	}
}
