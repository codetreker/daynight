package workerreadonly

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestBoundRequesterRetainsAuthorityAcrossEveryDeliveryBoundary(t *testing.T) {
	for _, refuseAt := range []int{0, 1, 2, 3} {
		t.Run(string(rune('0'+refuseAt)), func(t *testing.T) {
			actor := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			producer := model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}
			workerID := uuid.NewString()
			refusal := errors.New("current Bot authority refused")
			publicCalls, producerCalls, calls := 0, 0, 0
			b := NewWithAuthorization(func(context.Context, model.Principal, string) error {
				publicCalls++
				return errors.New("inspection not granted")
			}, func(ctx context.Context, p model.Principal, worker string) error {
				producerCalls++
				if p != producer || worker != workerID || ctx.Err() != nil {
					t.Errorf("producer facts changed: %+v %s %v", p, worker, ctx.Err())
				}
				return nil
			})
			defer b.Close()
			c, err := b.Connect(t.Context(), producer, workerID, Hello{Type: "hello", Protocol: Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}})
			if err != nil {
				t.Fatal(err)
			}
			requester := b.NewRequester(func(ctx context.Context, p model.Principal, worker string) error {
				calls++
				if p != actor || worker != workerID || ctx.Err() != nil {
					t.Errorf("requester facts changed: %+v %s %v", p, worker, ctx.Err())
				}
				if calls == refuseAt {
					return refusal
				}
				return nil
			})
			type outcome struct {
				message Message
				err     error
			}
			done := make(chan outcome, 1)
			go func() {
				m, err := requester.Request(t.Context(), actor, workerID, Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
				done <- outcome{m, err}
			}()
			if refuseAt != 1 {
				var request Message
				select {
				case request = <-c.Messages:
				case <-time.After(time.Second):
					t.Fatal("request not dispatched")
				}
				response := Message{Fence: request.Fence, Type: "result", RequestID: request.RequestID, Result: json.RawMessage(`{"path":"/","parentPath":null,"entries":[],"nextCursor":null}`)}
				if err := b.Deliver(t.Context(), c, response); err != nil {
					t.Fatal(err)
				}
			}
			var got outcome
			select {
			case got = <-done:
			case <-time.After(time.Second):
				t.Fatal("request not completed")
			}
			if refuseAt == 0 {
				if got.err != nil || got.message.Type != "result" || calls != 3 || producerCalls != 4 {
					t.Fatalf("successful authority sequence: %+v %v requester=%d producer=%d", got.message, got.err, calls, producerCalls)
				}
			} else if !errors.Is(got.err, refusal) || !reflect.DeepEqual(got.message, Message{}) || calls != refuseAt {
				t.Fatalf("refusal lost: %+v %v requester=%d", got.message, got.err, calls)
			}
			if publicCalls != 0 {
				t.Fatalf("bound work entered public inspection: %d", publicCalls)
			}
			if err := b.Check(t.Context(), c); err != nil {
				t.Fatalf("requester refusal disconnected producer: %v", err)
			}
		})
	}
}

func TestBoundRequesterRequiresAuthority(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("nil bound authority accepted")
		}
	}()
	New(func(context.Context, model.Principal, string) error { return nil }).NewRequester(nil)
}
