package server

import (
	"errors"
	"reflect"
	"testing"
)

func TestRegisterMCPAdaptersStopsAndPropagatesFailures(t *testing.T) {
	projectErr := errors.New("project registration failed")
	taskErr := errors.New("task registration failed")
	for _, tc := range []struct {
		name       string
		projectErr error
		taskErr    error
		wantErr    error
		wantCalls  []string
	}{
		{name: "project fails", projectErr: projectErr, wantErr: projectErr, wantCalls: []string{"project"}},
		{name: "task fails", taskErr: taskErr, wantErr: taskErr, wantCalls: []string{"project", "task"}},
		{name: "both succeed", wantCalls: []string{"project", "task"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			err := registerMCPAdapters(func() error {
				calls = append(calls, "project")
				return tc.projectErr
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
