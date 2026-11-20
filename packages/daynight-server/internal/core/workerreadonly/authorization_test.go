package workerreadonly

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestBrokerSeparatesRequesterAndProducerAuthorization(t *testing.T) {
	producer := brokerPrincipal()
	requester := producer
	requester.CredentialID = uuid.NewString()
	worker := uuid.NewString()
	requesterCalls, producerCalls := 0, 0
	broker := NewWithAuthorization(func(_ context.Context, principal model.Principal, workerID string) error {
		requesterCalls++
		if principal != requester || workerID != worker {
			t.Errorf("wrong requester authorization: %+v %s", principal, workerID)
		}
		return nil
	}, func(_ context.Context, principal model.Principal, workerID string) error {
		producerCalls++
		if principal != producer || workerID != worker {
			t.Errorf("wrong producer authorization: %+v %s", principal, workerID)
		}
		return nil
	})
	defer broker.Close()
	connection, err := broker.Connect(t.Context(), producer, worker, brokerHello())
	if err != nil {
		t.Fatal(err)
	}
	answer := make(chan error, 1)
	go func() { _, err := broker.Request(t.Context(), requester, worker, brokerInput()); answer <- err }()
	request := receiveRequest(t, connection)
	if err := broker.Deliver(t.Context(), connection, Message{Fence: request.Fence, Type: "result", RequestID: request.RequestID, Error: &Error{Code: "not_found", Message: "missing"}}); err != nil {
		t.Fatal(err)
	}
	if err := <-answer; err != nil {
		t.Fatal(err)
	}
	if requesterCalls != 3 || producerCalls != 4 {
		t.Fatalf("authorization boundaries: requester=%d producer=%d", requesterCalls, producerCalls)
	}
}

func TestBrokerRejectsMissingAuthorization(t *testing.T) {
	allow := Authorize(func(context.Context, model.Principal, string) error { return nil })
	for _, callbacks := range [][2]Authorize{{nil, allow}, {allow, nil}} {
		func() {
			defer func() {
				if recover() == nil {
					t.Error("missing authorization accepted")
				}
			}()
			NewWithAuthorization(callbacks[0], callbacks[1])
		}()
	}
}
