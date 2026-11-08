package bot

import (
	"context"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestCreationRejectsOverflowWithoutChangingFullDefaults(t *testing.T) {
	bots, db, principal, worker := botService(t)
	ctx := context.Background()
	reportBotHost(t, db, principal, worker, "/selected")
	// The only usable Worker sorts after 100 unavailable candidates. Admission
	// normally prevents this state, but old data must not be silently truncated.
	_, err := db.Pool.Exec(ctx, `UPDATE workers SET created_at=statement_timestamp()+interval '1 second' WHERE user_id=$1 AND worker_id=$2`, principal.UserID, worker)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 SELECT user_id,gen_random_uuid(),statement_timestamp()-interval '1 second',last_seen_at,
 jsonb_set(telemetry,'{assistantHost,defaultProvider}', '"claude"'::jsonb),task_snapshot
 FROM workers CROSS JOIN generate_series(1,100) WHERE user_id=$1 AND worker_id=$2`, principal.UserID, worker)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	_, err = bots.CreateResolved(ctx, principal, botcore.CreateBot{ID: id, Name: "overflow"})
	requireFault(t, err, "active_worker_limit_exceeded")
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM bots WHERE id=$1`, id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("bot count %d: %v", count, err)
	}
	defaults, err := bots.Defaults(ctx, principal, &worker)
	if err != nil || len(defaults.Workers) != 101 || defaults.Configuration == nil || defaults.Configuration.WorkerID != worker {
		t.Fatalf("full defaults: %d %+v %v", len(defaults.Workers), defaults.Configuration, err)
	}
	created, err := bots.CreateResolved(ctx, principal, botcore.CreateBot{ID: uuid.NewString(), Name: "explicit", Overrides: model.BotOverrides{WorkerID: &worker}})
	if err != nil || created.ResolvedConfiguration.WorkerID != worker {
		t.Fatalf("explicit: %+v %v", created, err)
	}
}
