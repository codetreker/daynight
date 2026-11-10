package bot

import (
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
