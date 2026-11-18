//go:build usageperformance

package usage_test

import (
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

// Run explicitly with -tags usageperformance -run TestUsagePerformance -timeout
// 15m; this qualification workload is excluded from all ordinary CI suites.
func TestUsagePerformance(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,title,description,status) SELECT gen_random_uuid(),$1,'Usage performance','', 'todo' FROM generate_series(1,99)`, f.project)
	rows, err := f.db.Pool.Query(ctx, `SELECT id::text FROM tasks WHERE project_id=$1 ORDER BY id`, f.project)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,connection_parent_credential_id)
 SELECT gen_random_uuid(),t.project_id,t.id,gen_random_uuid(),$2,gen_random_uuid(),'{}','{"executionGeneration":"1","lifecycle":"archived"}',$3,$3
 FROM tasks t CROSS JOIN generate_series(1,10) WHERE t.project_id=$1`, f.project, f.actor.UserID, f.actor.CredentialID)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO usage_records(id,record_kind,scope,project_id,task_id,session_id,claim_id,execution_generation,native_authority_user_id,provider,native_session_id,profile_id,provider_version,capability,collection_state,reason_codes,state_sequence,sealed_at,observed_at,created_at,updated_at,row_version,body_hash,grant_hash)
 SELECT gen_random_uuid(),'execution_state','task',s.project_id,s.task_id,s.id,s.claim_id,1,s.owner_user_id,'copilot',s.id::text,'copilot-event-1.0.11-v1','performance',
 '{"profileId":"copilot-event-1.0.11-v1","qualification":"verified","measurementPlane":"native_event","completion":"partial_only"}','partial','[]',1,now(),now(),now(),now(),1,decode(repeat('ab',32),'hex'),decode('01'||repeat('00',64),'hex')
 FROM task_sessions s WHERE s.project_id=$1 AND s.id<>$2`, f.project, f.session)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO usage_records(id,record_kind,scope,project_id,task_id,session_id,claim_id,execution_generation,native_authority_user_id,provider,native_session_id,state_id,source_key,profile_id,provider_version,revision_authority,source_revision,finality,disposition,aggregation_role,output_tokens,reason_codes,observed_at,created_at,updated_at,row_version,body_hash)
 SELECT gen_random_uuid(),'measurement','task',s.project_id,s.task_id,s.session_id,s.claim_id,1,s.native_authority_user_id,'copilot',s.native_session_id,s.id,'performance-v1:'||n,'copilot-event-1.0.11-v1','performance','immutable',1,'final','active','counted',1,'[]',now(),now(),now(),1,decode(repeat('ab',32),'hex')
 FROM usage_records s CROSS JOIN generate_series(1,100) n WHERE s.project_id=$1 AND s.record_kind='execution_state'`, f.project)
	testutil.MustExec(t, f.db.Pool, `ANALYZE usage_records; ANALYZE task_sessions; ANALYZE tasks`)
	trace := traceUsageQueries(t, f)
	qualify := func(name string, max time.Duration, operation func() error) {
		t.Helper()
		for i := 0; i < 5; i++ {
			if e := operation(); e != nil {
				t.Fatal(e)
			}
		}
		times := make([]time.Duration, 30)
		for i := range times {
			start := time.Now()
			if e := operation(); e != nil {
				t.Fatal(e)
			}
			times[i] = time.Since(start)
		}
		sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
		p95 := times[28]
		t.Logf("%s warm=5 measured=30 p95=%s target=%s", name, p95, max)
		if p95 > max {
			t.Errorf("%s P95 exceeds target", name)
		}
	}
	qualify("100 Task batch summary, 1000 state / 100000 measurements", 500*time.Millisecond, func() error { _, e := f.service.TaskSummaries(ctx, f.actor, f.project, ids); return e })
	trace.explain(t, f.db.Pool)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO usage_records SELECT (jsonb_populate_record(NULL::usage_records,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'source_key','performance-extra:'||n))).*
 FROM usage_records r CROSS JOIN generate_series(1,9000) n WHERE r.id=(SELECT id FROM usage_records WHERE project_id=$1 AND task_id=$2 AND record_kind='measurement' LIMIT 1)`, f.project, ids[0])
	testutil.MustExec(t, f.db.Pool, `ANALYZE usage_records`)
	qualify("100-row page in 10000-record Task", 200*time.Millisecond, func() error {
		_, e := f.service.Records(ctx, f.actor, f.project, ids[0], "", app.PageRequest{Kind: "measurement", Limit: 100})
		return e
	})
	trace.explain(t, f.db.Pool)
	goal := uuid.NewString()
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,title,description,status,type) VALUES($1,$2,'Usage boundary','','todo','goal')`, goal, f.project)
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,title,description,status,parent_id) SELECT gen_random_uuid(),$1,'Boundary','','todo',$2 FROM generate_series(1,10000)`, f.project, goal)
	aggregate, err := f.service.Aggregate(ctx, f.actor, f.project, "goal", goal, "")
	if err != nil || aggregate.Members.Total != "10000" {
		t.Fatal(aggregate.Members, err)
	}
	testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,title,description,status,parent_id) VALUES($1,$2,'Too many','','todo',$3)`, uuid.NewString(), f.project, goal)
	_, err = f.service.Aggregate(ctx, f.actor, f.project, "goal", goal, "")
	requireCode(t, err, "aggregate_scope_too_large")
	t.Log(fmt.Sprintf("aggregate membership boundary: %s accepted; 10001 rejected", aggregate.Members.Total))
}
