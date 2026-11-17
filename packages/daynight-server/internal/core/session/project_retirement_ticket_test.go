package session

import (
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestProjectRetirementTicketPreservesReplacementsAndBoundsCleanup(t *testing.T) {
	var absent *ProjectRetirementTicket
	absent.Retire()
	(&ProjectRetirementTicket{}).Retire()
	s := NewEngine(nil)
	project := "project"
	changed := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	replaced := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	s.live["changed"], s.live["replaced"] = changed, replaced
	pending := &pendingContent{projectID: project, reply: make(chan contentReply, 1)}
	pending.reply <- contentReply{}
	stale := &pendingContent{projectID: project, reply: make(chan contentReply, 1)}
	s.content.pending = map[string]*pendingContent{"pending": pending, "stale": stale}
	ticket := s.CaptureProjectRetirement(project)
	changed.value = newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})
	replacement := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	s.live["replaced"] = replacement
	newPending := &pendingContent{projectID: project, reply: make(chan contentReply, 1)}
	s.content.pending["stale"] = newPending
	ticket.Retire()
	if s.live["changed"] != changed || s.live["replaced"] != replacement {
		t.Fatal("retired a newer live cell")
	}
	if _, ok := s.content.pending["pending"]; ok {
		t.Fatal("full pending reply remained registered")
	}
	if s.content.pending["stale"] != newPending {
		t.Fatal("retired a newer content request")
	}
}
