package postgres

import (
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestWebhookEventActorMigrationKeepsLegacyEventsUnknown(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 94 })
	if index < 1 {
		t.Fatal("webhook event actor migration is missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Legacy')`, queryID(10), project.ID)
	mustQueryExec(t, db, `INSERT INTO webhook_events
 (id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,
 occurred_at,recorded_at,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes)
 VALUES($1,'task.paused',1,1,'urn:daynight:project:' || $2::uuid::text,'tasks/' || $3::uuid::text,$2,$3,17,
 '2026-01-01T10:00:00Z','2026-01-01T10:00:01Z',1,convert_to('{}','UTF8'),sha256(convert_to('{}','UTF8')),2)`, queryID(90), project.ID, queryID(10))
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var nullable int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
 WHERE table_schema=current_schema() AND table_name='webhook_events'
 AND column_name IN ('actor_kind','actor_user_id','actor_bot_id') AND is_nullable='YES' AND column_default IS NULL`).Scan(&nullable); err != nil || nullable != 3 {
		t.Fatalf("actor columns: nullable=%d err=%v", nullable, err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	got, err := webhook.New(tx).CapturedEventProvenance(ctx, queryID(90))
	if err != nil || got.Actor != (wm.Actor{}) || got.FactRemovedAt != nil || len(got.FactSHA256) != 32 {
		t.Fatalf("legacy provenance = %+v err=%v", got, err)
	}
}
