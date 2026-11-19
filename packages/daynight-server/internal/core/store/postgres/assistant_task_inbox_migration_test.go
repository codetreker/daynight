package postgres

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pgassistant "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/assistanttask"
)

func TestAssistantTaskInboxMigrationKeepsExistingEvents(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.sql == assistantTaskInboxesSQL })
	if index < 1 {
		t.Fatal("missing inbox migration")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	owner, task, bot, settled, pending, expired := queryID(951), queryID(952), queryID(953), queryID(954), queryID(955), queryID(957)
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_tasks(id,owner_user_id,request_fingerprint,application,name,purpose,scope,kind,state,takeover,version,manual_version,claim_generation,created_at,updated_at)
		VALUES($1,$2,'f','','n','p','s','continuous','active','manual',1,1,0,clock_timestamp(),clock_timestamp())`, task, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO assistant_task_events(id,owner_user_id,task_id,request_fingerprint,target_bot_id,type,payload,state,attention,delivered_at,created_at)
		VALUES($1,$3,$4,'f',$5,'inbound','{}','delivered',false,'2020-01-01','2020-01-01'),($2,$3,$4,'f',$5,'inbound','{}','pending',false,NULL,'2020-01-01'),($6,$3,$4,'f',$5,'inbound','{}','expired',false,NULL,'2020-01-01')`, settled, pending, owner, task, bot, expired); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := pgassistant.New(tx)
	if n, err := dao.PendingInboundEvents(ctx, owner, task, bot, 10); err != nil || n != 1 {
		t.Fatalf("existing pending event: %d %v", n, err)
	}
	// A delivered event keeps its delivery time; an expired event has no
	// recorded expiry, so its retention starts at migration time.
	if n, err := dao.ReclaimInboundEvents(ctx, owner, task, time.Date(2021, 1, 1, 0, 0, 0, 0, time.UTC), 10); err != nil || n != 1 {
		t.Fatalf("existing delivered event: %d %v", n, err)
	}
	now, err := dao.Now(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := dao.ReclaimInboundEvents(ctx, owner, task, now, 10); err != nil || n != 1 {
		t.Fatalf("existing expired event: %d %v", n, err)
	}
	inbox := model.AssistantTaskInbox{InboxID: queryID(956), OwnerUserID: owner, TaskID: task, State: model.AssistantTaskInboxEnabled, Version: 1, CreatedAt: time.Now().UTC()}
	if ok, err := dao.InsertInbox(ctx, inbox); err != nil || !ok {
		t.Fatalf("inbox on migrated task: %v %v", ok, err)
	}
	if _, err := dao.CurrentInbox(ctx, owner, task); err != nil {
		t.Fatal(err)
	}
}
