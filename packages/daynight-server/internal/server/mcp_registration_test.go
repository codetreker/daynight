package server

import (
	"errors"
	"reflect"
	"testing"
)

func TestRegisterMCPAdaptersStopsAndPropagatesFailures(t *testing.T) {
	projectErr := errors.New("project registration failed")
	invitationErr := errors.New("invitation registration failed")
	taskErr := errors.New("task registration failed")
	for _, tc := range []struct {
		name          string
		projectErr    error
		invitationErr error
		taskErr       error
		wantErr       error
		wantCalls     []string
	}{
		{name: "project fails", projectErr: projectErr, wantErr: projectErr, wantCalls: []string{"project"}},
		{name: "invitation fails", invitationErr: invitationErr, wantErr: invitationErr, wantCalls: []string{"project", "invitation"}},
		{name: "task fails", taskErr: taskErr, wantErr: taskErr, wantCalls: []string{"project", "invitation", "task"}},
		{name: "all succeed", wantCalls: []string{"project", "invitation", "task"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			err := registerMCPAdapters(func() error {
				calls = append(calls, "project")
				return tc.projectErr
			}, func() error {
				calls = append(calls, "invitation")
				return tc.invitationErr
			}, func() error {
				calls = append(calls, "task")
				return tc.taskErr
			})
			if !errors.Is(err, tc.wantErr) || !reflect.DeepEqual(calls, tc.wantCalls) {
				t.Fatalf("registration: err=%v calls=%v", err, calls)
			}
		})
	}
}

func TestMCPRegistrationStopsAtEveryFailure(t *testing.T) {
	failure := errors.New("registration failed")
	for _, index := range []int{0, 1, 2, 3, 4} {
		calls := 0
		adapters := make([]func() error, 5)
		for i := range adapters {
			adapters[i] = func() error {
				calls++
				if i == index {
					return failure
				}
				return nil
			}
		}
		err := registerMCPAdapters(adapters...)
		if !errors.Is(err, failure) || calls != index+1 {
			t.Fatalf("failure at %d: calls=%d err=%v", index, calls, err)
		}
	}
}
