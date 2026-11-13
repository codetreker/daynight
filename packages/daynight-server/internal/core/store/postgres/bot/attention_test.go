package bot_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	assistantpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/assistanttask"
	"github.com/google/uuid"
)

func TestBotAttentionCountsUnseenEventsAndCurrentHolderProposals(t *testing.T) {
	f := newFixture(t)
	bot := f.insert(t, f.candidate)
	other := f.candidate
	other.ID = uuid.NewString()
	other = f.insert(t, other)
	ctx := t.Context()
	dao := assistantpg.New(f.tx)
	owner, taskID := bot.OwnerUserID, uuid.NewString()
	exec(t, f.tx, `INSERT INTO assistant_tasks(id,owner_user_id,request_fingerprint,application,name,purpose,scope,kind,state,takeover,version,manual_version,claim_generation,holder_bot_id,created_at,updated_at) VALUES($1,$2,'','','Task','','','once','active','manual',1,1,1,$3,now(),now())`, taskID, owner, bot.ID)
	proposalID := uuid.NewString()
	exec(t, f.tx, `INSERT INTO assistant_task_proposals(id,owner_user_id,task_id,request_fingerprint,base_version,body,rules,reason,evidence_records,widens,status,decision_note,created_at) VALUES($1,$2,$3,'',1,'','[]','','[]',false,'pending','',now())`, proposalID, owner, taskID)
	insertEvent := func(eventOwner, target, kind string, attention bool, seen *time.Time) string {
		t.Helper()
		id := uuid.NewString()
		_, err := dao.InsertEvent(ctx, model.AssistantTaskEvent{ID: id, OwnerUserID: eventOwner, TaskID: taskID, TargetBotID: target, Type: kind, State: "delivered", Payload: json.RawMessage(`{}`), Attention: attention, SeenAt: seen, CreatedAt: time.Now().UTC()})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	reportID := insertEvent(owner, bot.ID, "report", true, nil)
	insertEvent(owner, bot.ID, "proposal_pending", true, nil)
	for _, kind := range []string{"direct_success", "appendix_added", "resolved"} {
		insertEvent(owner, bot.ID, kind, false, nil)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	insertEvent(owner, bot.ID, "escalation", true, &now)
	insertEvent(uuid.NewString(), bot.ID, "report", true, nil)
	insertEvent(owner, other.ID, "report", true, nil)
	assertCounts := func(wantBot, wantOther int64) {
		t.Helper()
		got, err := f.reader.Bot(ctx, bot.ID)
		if err != nil || got.AttentionCount != wantBot {
			t.Fatalf("detail attention=%d want=%d err=%v", got.AttentionCount, wantBot, err)
		}
		page, err := f.reader.Bots(ctx, owner, nil, store.Page{Limit: 10})
		if err != nil || len(page.Items) != 2 {
			t.Fatalf("list: %#v %v", page, err)
		}
		for _, item := range page.Items {
			want := wantBot
			if item.ID == other.ID {
				want = wantOther
			}
			if item.AttentionCount != want {
				t.Fatalf("list attention for %s=%d want=%d", item.ID, item.AttentionCount, want)
			}
		}
	}
	assertCounts(2, 1)
	if err := dao.MarkAttentionSeen(ctx, owner, bot.ID, now, []string{"proposal_pending"}); err != nil {
		t.Fatal(err)
	}
	assertCounts(1, 1)
	event, err := dao.Event(ctx, owner, taskID, reportID)
	if err != nil || event.SeenAt == nil || !event.SeenAt.Equal(now) {
		t.Fatalf("seen report: %#v %v", event, err)
	}
	// An expired lease retains the holder's pending decision until ownership changes.
	exec(t, f.tx, `UPDATE assistant_tasks SET lease_until=now()-interval '1 minute' WHERE id=$1`, taskID)
	assertCounts(1, 1)
	exec(t, f.tx, `UPDATE assistant_tasks SET holder_bot_id=$2 WHERE id=$1`, taskID, other.ID)
	assertCounts(0, 2)
	exec(t, f.tx, `UPDATE assistant_task_proposals SET status='rejected',decided_at=now() WHERE id=$1`, proposalID)
	assertCounts(0, 1)
	// A stale event for a decided proposal never resurrects its marker.
	exec(t, f.tx, `UPDATE assistant_tasks SET holder_bot_id=$2 WHERE id=$1`, taskID, bot.ID)
	assertCounts(0, 1)
	exec(t, f.tx, `UPDATE assistant_task_proposals SET status='pending',decided_at=NULL WHERE id=$1`, proposalID)
	exec(t, f.tx, `UPDATE assistant_tasks SET state='deleted' WHERE id=$1`, taskID)
	assertCounts(0, 1)
}
