package server

import (
	"errors"
	"testing"
)

func TestMCPRegistrationStopsAtFailure(t *testing.T) {
	failure := errors.New("registration failed")
	calls := 0
	register := func() error { calls++; return nil }
	err := registerMCPToolSet(register, func() error { calls++; return failure }, register)
	if !errors.Is(err, failure) || calls != 2 {
		t.Fatalf("registration continued after failure: calls=%d err=%v", calls, err)
	}
}
