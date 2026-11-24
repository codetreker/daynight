package postgres

import (
	"slices"
	"testing"

	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
)

func TestMigration126RejectsOnlyInvalidatedUnsentSessionOperations(t *testing.T) {
	pool := emptyPool(t)
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
