package session

import (
	"context"
	"errors"
	"testing"
	"time"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type operationsHistoryMarker struct{ HistoryReader }

func TestRoutesWithOperationsPreservesInstancesAndDefaults(t *testing.T) {
	ctx := t.Context()
	auth := &authhttp.RequestAuthentication{}
	logger := testLogger()
	history := &operationsHistoryMarker{}
	ignoredHistory := &operationsHistoryMarker{}
	firstError, secondError := errors.New("first operation"), errors.New("second operation")
	firstCalls, secondCalls := 0, 0
	first := NewRoutesWithOperations(Operations{AuthenticateController: func(actual context.Context, token string) error {
		firstCalls++
		if actual != ctx || token != "first token" {
			t.Fatal("first operation context or token changed")
		}
		return firstError
	}}, auth, logger, history, ignoredHistory)
	second := NewRoutesWithOperations(Operations{AuthenticateController: func(actual context.Context, token string) error {
		secondCalls++
		if actual != ctx || token != "second token" {
			t.Fatal("second operation context or token changed")
		}
		return secondError
	}}, auth, logger)
	if first.auth != auth || first.logger != logger || first.history != history || second.history != nil {
		t.Fatal("request authentication, logger or selected history instance changed")
	}
	if first.instance == "" || first.instance == second.instance || first.pingInterval != 10*time.Second || second.pingInterval != 10*time.Second {
		t.Fatal("route identity or production ping defaults changed")
	}
	if first.connections == nil || second.connections == nil {
		t.Fatal("route connection state was not allocated independently")
	}
	first.connections[nil] = func() {}
	if len(second.connections) != 0 {
		t.Fatal("route connection state is shared")
	}
	delete(first.connections, nil)
	if err := first.service.AuthenticateController(ctx, "first token"); err != firstError {
		t.Fatal("first operation result changed", err)
	}
	if err := second.service.AuthenticateController(ctx, "second token"); err != secondError {
		t.Fatal("second operation result changed", err)
	}
	if err := first.service.AuthenticateController(ctx, "first token"); err != firstError || firstCalls != 2 || secondCalls != 1 {
		t.Fatal("operation instances overwrite each other", err, firstCalls, secondCalls)
	}
}

func TestCallsFromServiceKeepsReceiverInstance(t *testing.T) {
	ctx := t.Context()
	firstError, secondError := errors.New("first service"), errors.New("second service")
	firstCalls, secondCalls := 0, 0
	makeService := func(cause error, calls *int) *sessionservice.Service {
		execution := sessioncore.NewExecution(nil, nil, nil, nil, nil, nil, nil,
			func(actual context.Context, hash []byte, _ func(*sessioncore.Access) error) error {
				*calls = *calls + 1
				if actual != ctx || len(hash) != 32 {
					t.Fatal("bound service context or controller hash changed")
				}
				return cause
			}, nil, nil, nil, nil, nil)
		return &sessionservice.Service{Execution: execution}
	}
	first := callsFromService(makeService(firstError, &firstCalls))
	second := callsFromService(makeService(secondError, &secondCalls))
	if err := first.AuthenticateController(ctx, "first controller"); err != firstError {
		t.Fatal("first receiver changed", err)
	}
	if err := second.AuthenticateController(ctx, "second controller"); err != secondError {
		t.Fatal("second receiver changed", err)
	}
	if err := first.AuthenticateController(ctx, "first controller"); err != firstError || firstCalls != 2 || secondCalls != 1 {
		t.Fatal("service method receivers overwrite each other", err, firstCalls, secondCalls)
	}
}
