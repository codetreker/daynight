package bot

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"reflect"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
)

func TestConstructorsBindProductionOperations(t *testing.T) {
	f := newBotFixture(t)
	requester := modelRequestFunc(nil)
	for _, s := range []*Bots{New(f), NewWithNativeDiscovery(f, requester)} {
		identical(t, s.store, f)
		for _, pair := range [][2]any{{s.operations.create, botcore.Create}, {s.operations.get, botcore.Get}, {s.operations.list, botcore.List}, {s.operations.creationDefaults, botcore.CreationDefaults}, {s.operations.defaults, botcore.ResolveBotDefaults}, {s.operations.workerDefaults, botcore.WorkerNativeDefaults}, {s.operations.nativeSelection, botcore.ResolveNativeSelection}} {
			if reflect.ValueOf(pair[0]).Pointer() != reflect.ValueOf(pair[1]).Pointer() {
				t.Fatal("production Bot binding changed")
			}
		}
	}
	s := NewDeletions(nil, nil, nil)
	for _, pair := range [][2]any{{s.operations.owner, botcore.RequireDeletionOwner}, {s.operations.request, botcore.DeletionRequest}, {s.operations.save, botcore.SaveDeletion}, {s.operations.worker, botcore.PrepareWorkerCleanup}, {s.operations.server, botcore.PrepareServerCleanup}, {s.operations.fail, botcore.FailServerCleanup}} {
		if reflect.ValueOf(pair[0]).Pointer() != reflect.ValueOf(pair[1]).Pointer() {
			t.Fatal("production deletion binding changed")
		}
	}
	before := time.Now()
	now := s.now()
	after := time.Now()
	if now.Before(before) || now.After(after) {
		t.Fatalf("production clock changed: %v", now)
	}
}

func TestLegacyCreationRequesterPreservesTheOriginalDiscoveryCall(t *testing.T) {
	p := testPrincipal()
	request := ro.Request{RequestID: "original-request", Operation: "model.list"}
	expected := ro.Message{Type: "result", RequestID: request.RequestID}
	calls := 0
	s := NewWithNativeDiscovery(nil, modelRequestFunc(func(ctx context.Context, got model.Principal, workerID string, gotRequest ro.Request) (ro.Message, error) {
		calls++
		if ctx != t.Context() || got != p || workerID != "selected-worker" || !reflect.DeepEqual(gotRequest, request) {
			t.Fatalf("legacy discovery facts changed: %+v %s %+v", got, workerID, gotRequest)
		}
		return expected, nil
	}))
	got, err := s.creationModels.RequestForOperations(t.Context(), p, "selected-worker", request, scopepolicy.BotWrite)
	if err != nil || !reflect.DeepEqual(got, expected) || calls != 1 {
		t.Fatalf("legacy discovery response changed: %+v %v %d", got, err, calls)
	}
	unavailable := NewWithNativeDiscovery(nil, nil)
	if unavailable.models != nil || unavailable.creationModels != nil {
		t.Fatal("absent legacy discovery was installed")
	}
}
