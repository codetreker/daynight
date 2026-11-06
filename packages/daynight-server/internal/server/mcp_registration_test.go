package server

import (
	"errors"
	"testing"
)

func TestMCPRegistrationStopsAtFailure(t *testing.T) {
	failure := errors.New("registration failed")
	for _, index := range []int{0, 1, 2, 3} {
		calls := 0
		adapters := make([]func() error, 4)
		for i := range adapters {
			adapters[i] = func() error {
				calls++
				if i == index {
					return failure
				}
				return nil
			}
		}
		err := registerMCPToolSet(adapters...)
		if !errors.Is(err, failure) || calls != index+1 {
			t.Fatalf("failure at %d: calls=%d err=%v", index, calls, err)
		}
	}
}
