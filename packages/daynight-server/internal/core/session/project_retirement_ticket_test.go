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
	frame := &terminalFrameWrite{projectID: project}
	s.terminalFrameWrites = map[string]*terminalFrameWrite{"frame": frame}
	body := &terminalBodyWrite{projectID: project}
	otherBody := &terminalBodyWrite{projectID: project}
	s.terminalPending = map[string]map[string]*terminalBodyWrite{"session": {"old": body, "replacement": otherBody}}
	ticket := s.CaptureProjectRetirement(project)
	changed.value = newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})
	replacement := &liveCell{value: newLive(sp.Snapshot{Identity: sp.Identity{ProjectID: project}})}
	s.live["replaced"] = replacement
	newPending := &pendingContent{projectID: project, reply: make(chan contentReply, 1)}
	s.content.pending["stale"] = newPending
	newBody := &terminalBodyWrite{projectID: project}
	s.terminalPending["session"]["replacement"] = newBody
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
	if s.terminalFrameWrites["frame"] != nil {
		t.Fatal("in-flight frame was not fenced")
	}
	if _, ok := s.terminalPending["session"]["old"]; ok {
		t.Fatal("captured terminal body remained")
	}
	if s.terminalPending["session"]["replacement"] != newBody {
		t.Fatal("retired a newer terminal body")
	}
	second := s.CaptureProjectRetirement(project)
	second.Retire()
	if len(s.terminalPending) != 0 {
		t.Fatal("empty terminal body namespace remained")
	}
}
