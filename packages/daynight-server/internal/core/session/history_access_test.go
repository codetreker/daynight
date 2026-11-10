package session

import (
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"testing"
)

func TestContentReadCapabilityIsConnectionLocal(t *testing.T) {
	old := newLive(sp.Snapshot{})
	old.ContentReadVersion = 1
	if cloneLive(old).ContentReadVersion != 1 {
		t.Fatal("transaction lost capability")
	}
	fresh := newLive(sp.Snapshot{})
	if fresh.ContentReadVersion != 0 {
		t.Fatal("new connection inherited capability")
	}
}
