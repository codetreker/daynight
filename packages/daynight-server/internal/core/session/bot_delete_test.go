package session

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestBotBindingChecksRejectMismatchedSessionsWithoutDiscardingLiveState(t *testing.T) {
	engine := NewEngine(nil)
	id, unrelated := uuid.NewString(), uuid.NewString()
	engine.live[id] = &liveCell{value: newLive(sp.Snapshot{})}
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	bot := model.Bot{ID: uuid.NewString(), SessionID: &unrelated}
	if err := op.CheckBot(id, &bot); err == nil {
		t.Fatal("mismatched Bot binding accepted")
	}
	if engine.live[id] == nil {
		t.Fatal("binding conflict discarded unrelated live Session state")
	}
	bot.SessionID = &id
	if err := op.CheckBot(id, &bot); err != nil {
		t.Fatal(err)
	}
	bot.Deletion = &model.BotDeletion{DeletionID: uuid.NewString()}
	botFault(t, op.CheckBot(id, &bot), "resource_conflict")
	if engine.live[id] != nil {
		t.Fatal("deleted Bot retained its cached conversation")
	}
}
