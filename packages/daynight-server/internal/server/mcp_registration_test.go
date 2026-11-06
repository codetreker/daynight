package server

import (
	"errors"
	"testing"
)

func TestMCPRegistrationStopsOnProjectError(t *testing.T) {
	failure := errors.New("project registration failed")
	called := false
	err := registerMCPAdapters(func() error { return failure }, func() error {
		called = true
		return nil
	})
	if !errors.Is(err, failure) || called {
		t.Fatalf("registration continued after failure: err=%v invitations called=%t", err, called)
	}
}
