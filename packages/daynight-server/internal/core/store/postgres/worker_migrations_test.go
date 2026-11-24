package postgres

import (
	"errors"
	"slices"
	"testing"
	"time"

	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestWorkerWindowsProcessCleanupMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	migrateTo(t, pool, 111)
	database := &Store{Pool: pool}
	stamp := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	userID := queryID(1)
	for _, workerID := range []string{queryID(2), queryID(3), queryID(4), queryID(5)} {
		putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, stamp))
	}
	for _, fixture := range []struct{ id, desired string }{
		{queryID(2), `{"other":{"value":7}}`},
		{queryID(3), `{"enableWindowsProcessCleanup":true,"other":1}`},
		{queryID(4), `{"enableWindowsProcessCleanup":false}`},
	} {
		mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=$4,configuration_observation_revision=8,configuration_observation='{"items":[]}' WHERE user_id=$1 AND worker_id=$2`, userID, fixture.id, stamp, fixture.desired)
	}
	mustQueryExec(t, database, `UPDATE workers SET configuration_revision=9223372036854775807 WHERE user_id=$1 AND worker_id=$2`, userID, queryID(3))
	rows := func(query string) string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, query).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	unchanged := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE worker_id <> '` + queryID(2) + `'`)
	otherFacts := rows(`SELECT (to_jsonb(w)-'desired_configuration'-'configuration_revision'-'configuration_updated_at')::text FROM workers w WHERE worker_id = '` + queryID(2) + `'`)
	if err := migrate(ctx, pool, migrationsThrough(112)); err != nil {
		t.Fatal(err)
	}
	if got := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE worker_id <> '` + queryID(2) + `'`); got != unchanged {
		t.Fatalf("existing field or null configuration changed: before=%s after=%s", unchanged, got)
	}
	if got := rows(`SELECT (to_jsonb(w)-'desired_configuration'-'configuration_revision'-'configuration_updated_at')::text FROM workers w WHERE worker_id = '` + queryID(2) + `'`); got != otherFacts {
		t.Fatalf("unrelated worker facts changed: before=%s after=%s", otherFacts, got)
	}
	var desired string
	var revision int64
	var updated time.Time
	if err := pool.QueryRow(ctx, `SELECT desired_configuration::text,configuration_revision,configuration_updated_at FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, queryID(2)).Scan(&desired, &revision, &updated); err != nil {
		t.Fatal(err)
	}
	var expected bool
	if err := pool.QueryRow(ctx, `SELECT $1::jsonb = '{"other":{"value":7},"enableWindowsProcessCleanup":false}'::jsonb`, desired).Scan(&expected); err != nil || !expected || revision != 10 || !updated.After(stamp) {
		t.Fatalf("migrated desired=%s revision=%d updated=%v err=%v", desired, revision, updated, err)
	}
	beforeRepeat := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`)
	if err := migrate(ctx, pool, migrationsThrough(112)); err != nil {
		t.Fatal(err)
	}
	if got := rows(`SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`); got != beforeRepeat {
		t.Fatal("repeated migration changed worker facts")
	}
}

func platformTaskModeMigrationIndex(t *testing.T) int {
	t.Helper()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 121 })
	if index < 1 || schemaMigrations[index-1].version != 120 {
		t.Fatal("platform task mode migration must follow browser session management")
	}
	return index
}

func TestWorkerPlatformTaskModeMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	if err := migrate(ctx, pool, schemaMigrations[:platformTaskModeMigrationIndex(t)]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	stamp := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	user := queryID(1)
	for i := 2; i <= 6; i++ {
		putWorkerSnapshot(t, db, workerSnapshotFixture(user, queryID(i), stamp))
	}
	observation := `{"baseRevision":"4","desiredRevision":"9","items":[{"key":{"kind":"preferPlatformSpecificTasks"},"targetRevision":"9","appliedValue":true,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}],"reportedAt":"2020-01-02T00:00:00Z"}`
	for i, old := range []bool{false, true} {
		mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=jsonb_build_object('preferPlatformSpecificTasks',$4::boolean,'future',jsonb_build_object('nested',7)),configuration_observation_revision=5,configuration_observation=$5 WHERE user_id=$1 AND worker_id=$2`, user, queryID(i+2), stamp, old, observation)
	}
	for i, value := range []string{`{"platformTaskMode":"only","future":null}`, `{"future":{"nested":7}}`} {
		mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9223372036854775807,configuration_updated_at=$3,desired_configuration=$4 WHERE user_id=$1 AND worker_id=$2`, user, queryID(i+5), stamp, value)
	}
	var untouchedBefore, untouchedAfter string
	untouched := `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE worker_id IN ($1,$2,$3)`
	if err := pool.QueryRow(ctx, untouched, queryID(4), queryID(5), queryID(6)).Scan(&untouchedBefore); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var ledgerMatches bool
	if err := pool.QueryRow(ctx, `SELECT array_agg(version ORDER BY version)=ARRAY[120,121]::bigint[] FROM schema_migrations WHERE version IN (120,121)`).Scan(&ledgerMatches); err != nil || !ledgerMatches {
		t.Fatalf("ordered migration ledger differs: matches=%v err=%v", ledgerMatches, err)
	}
	for i, mode := range []string{"all", "prefer"} {
		var matches bool
		if err := pool.QueryRow(ctx, `SELECT desired_configuration=jsonb_build_object('platformTaskMode',$3::text,'future',jsonb_build_object('nested',7)) AND configuration_revision=10 AND configuration_updated_at>$4 AND configuration_observation_revision=5 AND configuration_observation=$5::jsonb FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(i+2), mode, stamp, observation).Scan(&matches); err != nil || !matches {
			t.Fatalf("mode %s migration differs: matches=%v err=%v", mode, matches, err)
		}
	}
	if err := pool.QueryRow(ctx, untouched, queryID(4), queryID(5), queryID(6)).Scan(&untouchedAfter); err != nil || untouchedBefore != untouchedAfter {
		t.Fatalf("migration changed uninitialized or non-boolean targets: %v", err)
	}
	var beforeReplay, afterReplay string
	all := `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`
	if err := pool.QueryRow(ctx, all).Scan(&beforeReplay); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, all).Scan(&afterReplay); err != nil || beforeReplay != afterReplay {
		t.Fatalf("replay changed worker facts: %v", err)
	}
}

func TestWorkerPlatformTaskModeMigrationOverflowRollsBack(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	if err := migrate(ctx, pool, schemaMigrations[:platformTaskModeMigrationIndex(t)]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user := queryID(1)
	for _, id := range []string{queryID(2), queryID(3)} {
		putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, time.Now().UTC()))
	}
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9,configuration_updated_at=now(),desired_configuration='{"preferPlatformSpecificTasks":true,"future":1}' WHERE user_id=$1`, user)
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9223372036854775807 WHERE user_id=$1 AND worker_id=$2`, user, queryID(3))
	var before, after string
	all := `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`
	if err := pool.QueryRow(ctx, all).Scan(&before); err != nil {
		t.Fatal(err)
	}
	err := migrate(ctx, pool, schemaMigrations)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22003" {
		t.Fatalf("expected revision overflow, got %v", err)
	}
	var ledger int
	if err := pool.QueryRow(ctx, all).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=121`).Scan(&ledger); err != nil || ledger != 0 || before != after {
		t.Fatalf("overflow changed rows or ledger: ledger=%d err=%v", ledger, err)
	}
}

func TestMigration126DropsWorkerLifecycleAndPreservesSessionOperations(t *testing.T) {
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 126 })
	if index < 2 || schemaMigrations[index-2].version != 124 || schemaMigrations[index-1].version != 125 {
		t.Fatal("expected worker lifecycle removal after migrations 124 and 125")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index-1]); err != nil {
		t.Fatal(err)
	}

	user, worker, session, operation := queryID(1), queryID(2), queryID(3), queryID(4)
	if _, err := pool.Exec(ctx, `WITH worker AS (
		INSERT INTO workers (user_id, worker_id, created_at, last_seen_at, telemetry, task_snapshot)
		VALUES ($1, $2, now(), now(), '{}', '{}')
		RETURNING user_id, worker_id
	)
	INSERT INTO worker_lifecycle (user_id, worker_id, protocol_version, intent_version, desired, admission, instance_epoch, updated_at)
	SELECT user_id, worker_id, 1, 3, 'enabled', 'open', 1, now() FROM worker`, user, worker); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_operations
		(session_id, operation_id, operation_seq, body_hash, command, actor_user_id, credential_id, credential_kind, receipt, worker_id, worker_intent_version)
		VALUES ($1, $2, 1, decode(repeat('ab', 32), 'hex'), '{}', $3, $3, 'pat', '{"state":"accepted"}', $4, 3)`,
		session, operation, user, worker); err != nil {
		t.Fatal(err)
	}

	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}

	const preserved = `SELECT
		(SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version IN (110, 125)),
		(SELECT to_jsonb(w)::text FROM workers w WHERE user_id = $1 AND worker_id = $2),
		(SELECT (to_jsonb(o) - 'worker_id' - 'worker_intent_version')::text
		 FROM session_operations o WHERE session_id = $3 AND operation_id = $4)`
	var oldMigration, oldWorker, oldOperation string
	if err := pool.QueryRow(ctx, preserved, user, worker, session, operation).Scan(&oldMigration, &oldWorker, &oldOperation); err != nil {
		t.Fatal(err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}

	var tablesGone, columnsGone bool
	if err := pool.QueryRow(ctx, `SELECT
		to_regclass('worker_lifecycle') IS NULL
		AND to_regclass('worker_lifecycle_operations') IS NULL
		AND to_regclass('worker_lifecycle_observations') IS NULL,
		NOT EXISTS (SELECT FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'session_operations'
			AND column_name IN ('worker_id', 'worker_intent_version'))`).Scan(&tablesGone, &columnsGone); err != nil {
		t.Fatal(err)
	}
	if !tablesGone || !columnsGone {
		t.Fatalf("worker lifecycle schema remains: tables removed=%t, columns removed=%t", tablesGone, columnsGone)
	}
	var newMigration, newWorker, newOperation string
	if err := pool.QueryRow(ctx, preserved, user, worker, session, operation).Scan(&newMigration, &newWorker, &newOperation); err != nil {
		t.Fatal(err)
	}
	if newMigration != oldMigration || newWorker != oldWorker || newOperation != oldOperation {
		t.Fatalf("upgrade changed retained rows: migrations 110 and 125=%t, worker=%t, session operation=%t",
			newMigration != oldMigration, newWorker != oldWorker, newOperation != oldOperation)
	}
	var checksum string
	if err := pool.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version = 126").Scan(&checksum); err != nil {
		t.Fatal(err)
	}
	if checksum != schemaMigrations[index].checksum() {
		t.Fatalf("migration 126 checksum: got %s, want %s", checksum, schemaMigrations[index].checksum())
	}
}

func TestMigration126RejectsOnlyInvalidatedUnsentSessionOperations(t *testing.T) {
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 126 })
	if index < 1 {
		t.Fatal("migration 126 missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}

	owner, open, closed, legacy := queryID(1), queryID(2), queryID(3), queryID(4)
	taskSession, closedSession, legacySession, independentSession, botSession := queryID(5), queryID(6), queryID(7), queryID(8), queryID(9)
	project, task, bot := queryID(10), queryID(11), queryID(13)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'bot-owner',now(),now())`, owner)
	exec(`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
		VALUES($1,$2,now(),now(),'{}','{}'),($1,$3,now(),now(),'{}','{}'),($1,$4,now(),now(),'{}','{}')`, owner, open, closed, legacy)
	exec(`INSERT INTO worker_lifecycle(user_id,worker_id,protocol_version,intent_version,desired,admission,updated_at)
		VALUES($1,$2,1,3,'enabled','open',now()),($1,$3,1,3,'disabled','closed',now())`, owner, open, closed)
	for i, binding := range []struct{ session, worker string }{{taskSession, open}, {closedSession, closed}, {legacySession, legacy}} {
		exec(`INSERT INTO task_sessions(id,scope,owner_user_id,project_id,task_id,claim_id,registration_id,registration,snapshot)
			VALUES($1,'task',$2,$3,$4,$5,gen_random_uuid(),'{}',jsonb_build_object('identity', jsonb_build_object('workerId',$6::text)))`,
			binding.session, owner, project, task, queryID(14+i), binding.worker)
	}
	exec(`INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,session_id,startup_result)
		VALUES($1,$2,$3,'Bot',repeat('0',64),'{}','{}',$4,'{}')`, bot, owner, closed, botSession)
	exec(`INSERT INTO bot_recovery(bot_id,worker_id,service_origin,machine_id,machine_name,identity_hash,hosting_generation)
		VALUES($1,$2,'https://example.test','machine','Machine',decode(repeat('00',32),'hex'),2)`, bot, open)
	exec(`INSERT INTO task_sessions(id,scope,owner_user_id,test_execution_id,registration_id,registration,snapshot,bot_id)
		VALUES($1,'test',$2,gen_random_uuid(),gen_random_uuid(),'{}','{}',NULL),
		      ($3,'test',$2,gen_random_uuid(),gen_random_uuid(),'{}','{}',$4)`, independentSession, owner, botSession, bot)

	cases := []struct {
		name, session, kind, state string
		worker                     any
		version                    any
		refused                    bool
	}{
		{"accepted stale intent after reopen", taskSession, "send_message", "accepted", open, 1, true},
		{"offered stale intent after reopen", taskSession, "update_setting", "offered", open, 2, true},
		{"disabled Worker at matching intent", closedSession, "send_message", "accepted", closed, 3, true},
		{"queued before lifecycle registration", taskSession, "refresh_controls", "accepted", open, nil, true},
		{"old Bot host at matching intent number", botSession, "send_message", "offered", closed, 3, true},
		{"current Bot host", botSession, "send_message", "accepted", open, 3, false},
		{"current intent", taskSession, "send_message", "accepted", open, 3, false},
		{"legacy Worker", legacySession, "send_message", "accepted", legacy, nil, false},
		{"independent Session", independentSession, "send_message", "accepted", nil, nil, false},
		{"cancel on disabled Worker", closedSession, "cancel", "offered", nil, nil, false},
		{"dispatch already authorized", taskSession, "send_message", "dispatching", open, 1, false},
		{"native acceptance", taskSession, "send_message", "provider_accepted", open, 1, false},
		{"unknown dispatch", taskSession, "send_message", "unknown", open, 1, false},
		{"terminal receipt", taskSession, "send_message", "confirmed", open, 1, false},
	}
	for i, tc := range cases {
		exec(`INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,
			credential_id,credential_kind,receipt,dispatch_epoch,worker_id,worker_intent_version)
			VALUES($1,$2,$3,decode(repeat('ab',32),'hex'),jsonb_build_object('kind',$4::text),
			       $5,$5,'pat',jsonb_build_object('state',$6::text,'error',NULL,'operationId',$2::uuid,'providerResult',NULL),
			       1,$7,$8)`, tc.session, queryID(20+i), i+1, tc.kind, owner, tc.state, tc.worker, tc.version)
	}

	historicalID := queryID(34)
	exec(`INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,
		credential_id,credential_kind,receipt,worker_id,worker_intent_version)
		VALUES($1,$2,15,decode(repeat('ab',32),'hex'),'{"kind":"send_message"}',$3,$3,'pat',
		       '{"state":"rejected","error":{"code":"worker_disabled","message":"Historical refusal."}}',$4,1)`,
		taskSession, historicalID, owner, open)

	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	dao := pgsession.New(tx)
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := queryID(20 + i)
			operation, err := dao.SessionOperation(ctx, tc.session, id)
			if err != nil {
				t.Fatal(err)
			}
			if operation.Receipt.OperationID != id || operation.Epoch == nil || *operation.Epoch != 1 || operation.Command.Kind != tc.kind {
				t.Fatalf("operation identity changed: %+v", operation)
			}
			if tc.refused {
				if operation.Receipt.State != "rejected" || operation.Receipt.Error == nil || operation.Receipt.Error.Code != "permission_or_state_changed" {
					t.Fatalf("missing durable pre-dispatch refusal: %+v", operation.Receipt)
				}
			} else if operation.Receipt.State != tc.state || operation.Receipt.Error != nil {
				t.Fatalf("unaffected operation changed: %+v", operation.Receipt)
			}
		})
	}
	historical, err := dao.SessionOperation(ctx, taskSession, historicalID)
	if err != nil || historical.Receipt.State != "rejected" || historical.Receipt.Error == nil ||
		historical.Receipt.Error.Code != "worker_disabled" || historical.Receipt.Error.Message != "Historical refusal." {
		t.Fatalf("historical refusal changed: %+v, %v", historical.Receipt, err)
	}
	accepted, err := dao.AcceptedSessionOperations(ctx, taskSession)
	if err != nil || !slices.Equal(accepted, []string{queryID(26)}) {
		t.Fatalf("operations eligible for Poll after upgrade: %v, %v", accepted, err)
	}
	unreconciled, err := dao.UnreconciledSessionOperations(ctx, taskSession, 2)
	if err != nil || !slices.Equal(unreconciled, []string{queryID(30)}) {
		t.Fatalf("operations eligible for reconciliation on reconnect: %v, %v", unreconciled, err)
	}
}
