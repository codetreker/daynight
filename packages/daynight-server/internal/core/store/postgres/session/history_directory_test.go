package session_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestHistoryDirectoryGraphPagesAndOriginalClaims(t *testing.T) {
	db := isolatedStore(t)
	task, sessionID := prepareArchiveSession(t, db)
	member := queryTask(t, db, task.ProjectID, 3, model.TaskCancelled)
	independent := queryTask(t, db, task.ProjectID, 4, model.TaskDone)
	unknown := queryTask(t, db, task.ProjectID, 5, model.TaskDone)
	unfinished := queryTask(t, db, task.ProjectID, 6, model.TaskInProgress)
	deleted := queryTask(t, db, task.ProjectID, 7, model.TaskDone)
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	mustQueryExec(t, db, `UPDATE tasks SET completed_at=$1 WHERE id IN ($2,$3,$4)`, at, task.ID, independent.ID, deleted.ID)
	mustQueryExec(t, db, `UPDATE tasks SET completed_at=$1 WHERE id=$2`, at.Add(-time.Hour), task.ID)
	mustQueryExec(t, db, `UPDATE tasks SET cancelled_at=$1 WHERE id=$2`, at, member.ID)
	mustQueryExec(t, db, `UPDATE tasks SET completed_at=NULL WHERE id=$1`, unknown.ID)
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=$1 WHERE id=$2`, at, deleted.ID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false),($1,$3,$4,true),($1,$2,$5,false)`, task.ProjectID, task.ID, member.ID, unfinished.ID, deleted.ID)
	second := uuid.NewString()
	mustQueryExec(t, db, `UPDATE task_sessions SET created_at=$1 WHERE id=$2`, at, sessionID)
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,created_at) SELECT $2,project_id,task_id,$2,owner_user_id,$2,registration,snapshot,$3 FROM task_sessions WHERE id=$1`, sessionID, second, at)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.SetSessionArchiveReady(t.Context(), sessionID, archiveHashOf("archive"), 7, "archive/path"); err != nil {
			return err
		}
		return dao.(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(t.Context(), sessionID, at)
	})
	expired := at.Add(7 * 24 * time.Hour)
	mustQueryExec(t, db, `UPDATE session_archive_retention SET expired_at=$1,reason='expired' WHERE session_id=$2`, expired, sessionID)
	var firstFence string
	read := func(work func(store.HistoryDirectoryDAO) error) {
		t.Helper()
		if err := db.ReadHistoryDirectory(t.Context(), func(scope store.HistoryDirectoryScope) error { return work(scope.HistoryDirectoryDAO()) }); err != nil {
			t.Fatal(err)
		}
	}
	read(func(dao store.HistoryDirectoryDAO) error {
		var err error
		firstFence, err = dao.Fence(t.Context(), task.ProjectID)
		if err != nil {
			return err
		}
		groups, err := dao.Groups(t.Context(), task.ProjectID, nil, 20)
		if err != nil {
			return err
		}
		if len(groups) != 4 || groups[0].ID != task.ID || groups[0].MemberCount != 2 || groups[0].TimeState != "ended" || !groups[0].EndedAt.Equal(at) || groups[1].ID != independent.ID || groups[2].ID != unknown.ID || groups[2].TimeState != "unknown" || groups[3].ID != unfinished.ID || groups[3].TimeState != "unfinished" {
			t.Fatalf("groups: %+v", groups)
		}
		var got []store.HistoryDirectoryGroup
		var after *store.HistoryGroupPosition
		for {
			page, err := dao.Groups(t.Context(), task.ProjectID, after, 1)
			if err != nil {
				return err
			}
			if len(page) == 0 {
				break
			}
			got = append(got, page...)
			after = &store.HistoryGroupPosition{ID: page[0].ID, EndedAt: page[0].EndedAt}
		}
		if !reflect.DeepEqual(got, groups) {
			t.Fatalf("group pages differ: %+v", got)
		}
		members, err := dao.Members(t.Context(), task.ProjectID, task.ID, "", 1)
		if err != nil {
			return err
		}
		if len(members) != 1 || members[0].TaskID != task.ID {
			t.Fatalf("members: %+v", members)
		}
		next, err := dao.Members(t.Context(), task.ProjectID, task.ID, task.ID, 2)
		if err != nil {
			return err
		}
		if len(next) != 1 || next[0].TaskID != member.ID {
			t.Fatalf("member page: %+v", next)
		}
		facts, err := dao.RetentionMembers(t.Context(), task.ProjectID, member.ID)
		if err != nil {
			return err
		}
		if len(facts) != 2 || facts[0].TaskID != task.ID || facts[1].TaskID != member.ID {
			t.Fatalf("retention chain: %+v", facts)
		}
		sessions, err := dao.Sessions(t.Context(), task.ProjectID, task.ID, nil, 3)
		if err != nil {
			return err
		}
		if len(sessions) != 2 || sessions[0].ID <= sessions[1].ID {
			t.Fatalf("sessions: %+v", sessions)
		}
		for _, s := range sessions {
			if s.ID == sessionID {
				if s.Retention == nil || !s.Retention.FirstSucceededAt.Equal(at) || !s.Retention.ExpiredAt.Equal(expired) || s.Claim == second {
					t.Fatalf("original archive: %+v", s)
				}
			} else if s.ID != second || s.Claim != second || s.Retention != nil {
				t.Fatalf("new claim: %+v", s)
			}
		}
		older, err := dao.Sessions(t.Context(), task.ProjectID, task.ID, &store.Position{CreatedAt: sessions[0].Created, ID: sessions[0].ID}, 3)
		if err != nil {
			return err
		}
		if len(older) != 1 || older[0].ID != sessions[1].ID {
			t.Fatalf("session page: %+v", older)
		}
		for _, id := range []string{deleted.ID, uuid.NewString()} {
			empty, err := dao.Sessions(t.Context(), task.ProjectID, id, nil, 2)
			if err != nil {
				return err
			}
			if len(empty) != 0 {
				t.Fatalf("invisible task: %+v", empty)
			}
		}
		empty, err := dao.Groups(t.Context(), uuid.NewString(), nil, 2)
		if err != nil {
			return err
		}
		if len(empty) != 0 {
			t.Fatal("cross project leak")
		}
		return nil
	})
	// The same snapshot retains original facts while a concurrent transaction
	// publishes changes. The next snapshot must invalidate its paging fence.
	read(func(dao store.HistoryDirectoryDAO) error {
		before, err := dao.Fence(t.Context(), task.ProjectID)
		if err != nil {
			return err
		}
		mustQueryExec(t, db, `UPDATE session_archives SET sha256=$2 WHERE session_id=$1`, sessionID, archiveHashOf("replacement"))
		after, err := dao.Fence(t.Context(), task.ProjectID)
		if err != nil {
			return err
		}
		if before != after {
			t.Fatal("snapshot changed")
		}
		return nil
	})
	read(func(dao store.HistoryDirectoryDAO) error {
		value, err := dao.Fence(t.Context(), task.ProjectID)
		if err == nil && value == firstFence {
			t.Fatal("archive change did not change fence")
		}
		firstFence = value
		return err
	})
	terminalID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state)
 SELECT $2,project_id,task_id,$2,owner_user_id,$2,registration,NULL,'herdr','{"Envelope":{"executionGeneration":"7"},"Runs":[{"stoppedAt":"2026-10-31T00:00:00Z"},{"stoppedAt":"2026-11-01T00:00:00Z"}]}' FROM task_sessions WHERE id=$1`, sessionID, terminalID)
	read(func(dao store.HistoryDirectoryDAO) error {
		value, err := dao.Fence(t.Context(), task.ProjectID)
		if err == nil && value == firstFence {
			t.Fatal("new claim did not change directory fence")
		}
		firstFence = value
		return err
	})
	mustQueryExec(t, db, `UPDATE task_sessions SET terminal_state=terminal_state||jsonb_build_object('Recording',
 (SELECT jsonb_object_agg(('00000000-0000-4000-8000-'||lpad(i::text,12,'0')),jsonb_build_object('ObservedContent',true)) FROM generate_series(1,512)i)) WHERE id=$1`, terminalID)
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=snapshot||jsonb_build_object('cleanupInteractionIds',
 (SELECT jsonb_agg('00000000-0000-4000-8000-'||lpad(i::text,12,'0')) FROM generate_series(1,512)i)) WHERE id=$1`, sessionID)
	read(func(dao store.HistoryDirectoryDAO) error {
		value, err := dao.Fence(t.Context(), task.ProjectID)
		if err == nil && value != firstFence {
			t.Fatal("unrelated terminal detail invalidated directory")
		}
		if err != nil {
			return err
		}
		rows, err := dao.Sessions(t.Context(), task.ProjectID, task.ID, nil, 10)
		if err != nil {
			return err
		}
		if len(rows) != 3 {
			t.Fatalf("projected sessions: %d", len(rows))
		}
		for _, row := range rows {
			if len(row.Snapshot) != 0 || len(row.Terminal) != 0 {
				t.Fatal("directory loaded full Session JSON")
			}
			if row.ID == terminalID {
				if row.ExecutionGeneration != "7" || row.EndedAt == nil || *row.EndedAt != "2026-11-01T00:00:00Z" {
					t.Fatalf("terminal directory projection: %+v", row)
				}
			} else if row.ExecutionGeneration != "1" || row.EndedAt != nil {
				t.Fatalf("web directory projection: %+v", row)
			}
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE tasks SET version=version+1 WHERE id=$1`, member.ID)
	read(func(dao store.HistoryDirectoryDAO) error {
		value, err := dao.Fence(t.Context(), task.ProjectID)
		if err == nil && value == firstFence {
			t.Fatal("task change did not change fence")
		}
		return err
	})
	for _, limit := range []int{0, 202} {
		read(func(dao store.HistoryDirectoryDAO) error {
			if _, err := dao.Groups(t.Context(), task.ProjectID, nil, limit); err == nil {
				t.Fatal("invalid group limit")
			}
			if _, err := dao.Members(t.Context(), task.ProjectID, task.ID, "", limit); err == nil {
				t.Fatal("invalid member limit")
			}
			if _, err := dao.Sessions(t.Context(), task.ProjectID, task.ID, nil, limit); err == nil {
				t.Fatal("invalid session limit")
			}
			return nil
		})
	}
	marker := errors.New("directory callback failed")
	read(func(dao store.HistoryDirectoryDAO) error {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		checks := []func() error{
			func() error { _, err := dao.Fence(ctx, task.ProjectID); return err },
			func() error { _, err := dao.Groups(ctx, task.ProjectID, nil, 2); return err },
			func() error { _, err := dao.Members(ctx, task.ProjectID, task.ID, "", 2); return err },
			func() error { _, err := dao.RetentionMembers(ctx, task.ProjectID, task.ID); return err },
			func() error { _, err := dao.Sessions(ctx, task.ProjectID, task.ID, nil, 2); return err },
		}
		for _, check := range checks {
			if err := check(); !errors.Is(err, context.Canceled) {
				t.Fatalf("query cancellation lost: %v", err)
			}
		}
		return nil
	})
	if err := db.ReadHistoryDirectory(t.Context(), func(store.HistoryDirectoryScope) error { return marker }); !errors.Is(err, marker) {
		t.Fatalf("callback cause: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := db.ReadHistoryDirectory(ctx, func(store.HistoryDirectoryScope) error { t.Fatal("cancelled callback ran"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestHistoryDirectoryComponentsFollowVisibleGraphChanges(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	for _, number := range []int{10, 11, 12, 20, 21, 30, 40, 50, 51, 52} {
		queryTask(t, db, project.ID, number, model.TaskTodo)
	}
	mustQueryExec(t, db, `UPDATE tasks SET type='goal' WHERE id IN ($1,$2)`, queryID(40), queryID(50))
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id IN ($1,$2)`, queryID(50), queryID(52))
	mustQueryExec(t, db, `UPDATE tasks SET parent_id=$1,ancestor_deleted_at=(SELECT deleted_at FROM tasks WHERE id=$1) WHERE id=$2`, queryID(50), queryID(51))
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external,dependency_type) VALUES
 ($1,$2,$3,false,'task'),($1,$3,$4,false,'task'),($1,$5,$6,false,'task'),
 ($1,$3,$5,true,'task'),($1,$2,$6,false,'goal'),
 ($1,$3,$7,false,'task'),($1,$7,$5,false,'task'),
 ($1,$4,$8,false,'task'),($1,$8,$5,false,'task'),
 ($1,$2,$9,false,'task'),($1,$9,$5,false,'task')`,
		project.ID, queryID(10), queryID(11), queryID(12), queryID(20), queryID(21), queryID(40), queryID(51), queryID(52))

	check := func(dao store.HistoryDirectoryDAO, wantGroups map[string]int, start string, wantMembers []string) error {
		t.Helper()
		groups, err := dao.Groups(t.Context(), project.ID, nil, 20)
		if err != nil {
			return err
		}
		gotGroups := make(map[string]int, len(groups))
		for _, group := range groups {
			gotGroups[group.ID] = group.MemberCount
		}
		if !reflect.DeepEqual(gotGroups, wantGroups) {
			t.Fatalf("groups = %v, want %v", gotGroups, wantGroups)
		}
		members, err := dao.RetentionMembers(t.Context(), project.ID, start)
		if err != nil {
			return err
		}
		ids := make([]string, 0, len(members))
		for _, member := range members {
			ids = append(ids, member.TaskID)
		}
		if !reflect.DeepEqual(ids, wantMembers) {
			t.Fatalf("retention members from %s = %v, want %v", start, ids, wantMembers)
		}
		return nil
	}
	initialGroups := map[string]int{queryID(10): 3, queryID(20): 2, queryID(30): 1}
	initialMembers := []string{queryID(10), queryID(11), queryID(12)}
	if err := db.ReadHistoryDirectory(t.Context(), func(scope store.HistoryDirectoryScope) error {
		dao := scope.HistoryDirectoryDAO()
		if err := check(dao, initialGroups, queryID(12), initialMembers); err != nil {
			return err
		}
		nonminimum, err := dao.Members(t.Context(), project.ID, queryID(12), "", 20)
		if err != nil {
			return err
		}
		if len(nonminimum) != 0 {
			t.Fatalf("nonminimum group accepted: %+v", nonminimum)
		}
		for _, hidden := range []string{queryID(40), queryID(50), queryID(51), queryID(52)} {
			members, err := dao.RetentionMembers(t.Context(), project.ID, hidden)
			if err != nil {
				return err
			}
			if len(members) != 0 {
				t.Fatalf("hidden task %s is reachable: %+v", hidden, members)
			}
		}
		// A later graph write must not change any query within this snapshot.
		mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, queryID(12), queryID(20))
		return check(dao, initialGroups, queryID(12), initialMembers)
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadHistoryDirectory(t.Context(), func(scope store.HistoryDirectoryScope) error {
		return check(scope.HistoryDirectoryDAO(), map[string]int{queryID(10): 5, queryID(30): 1}, queryID(21), []string{queryID(10), queryID(11), queryID(12), queryID(20), queryID(21)})
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND depends_on_task_id=$3`, project.ID, queryID(11), queryID(12))
	if err := db.ReadHistoryDirectory(t.Context(), func(scope store.HistoryDirectoryScope) error {
		return check(scope.HistoryDirectoryDAO(), map[string]int{queryID(10): 2, queryID(12): 3, queryID(30): 1}, queryID(21), []string{queryID(12), queryID(20), queryID(21)})
	}); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryDirectoryGroupsCancellationWhileReadingGraph(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	queryTask(t, db, project.ID, 10, model.TaskTodo)
	for _, scenario := range []struct{ name, table, query, phase string }{
		{"vertices", "tasks", "SELECT id::text FROM task_resource_rows%", "read history directory vertices"},
		{"edges", "task_dependencies", "SELECT d.task_id::text,d.depends_on_task_id::text%", "read history directory edges"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			bounded, stop := context.WithTimeout(t.Context(), 10*time.Second)
			defer stop()
			holder, err := db.Pool.Begin(bounded)
			if err != nil {
				t.Fatal(err)
			}
			defer rollbackSessionTestTransaction(t, holder)
			if _, err := holder.Exec(bounded, "LOCK TABLE "+scenario.table+" IN ACCESS EXCLUSIVE MODE"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(bounded)
			type outcome struct{ operation, snapshot error }
			finished := make(chan outcome, 1)
			go func() {
				var operation error
				snapshot := db.ReadHistoryDirectory(ctx, func(scope store.HistoryDirectoryScope) error {
					_, operation = scope.HistoryDirectoryDAO().Groups(ctx, project.ID, nil, 2)
					return operation
				})
				finished <- outcome{operation, snapshot}
			}()
			drained := false
			defer func() {
				cancel()
				if !drained {
					rollbackSessionTestTransaction(t, holder)
					select {
					case <-finished:
					case <-time.After(5 * time.Second):
						t.Error("history directory query did not stop during cleanup")
					}
				}
			}()
			var reader int32
			for reader == 0 {
				err := db.Pool.QueryRow(bounded, `SELECT coalesce((SELECT pid FROM pg_stat_activity
 WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE $1 AND $2::integer=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`,
					scenario.query, holder.Conn().PgConn().PID()).Scan(&reader)
				if err != nil {
					t.Fatal(err)
				}
				if reader == 0 {
					if err := testutil.WaitThreadClock(bounded); err != nil {
						t.Fatalf("%s query did not wait for its lock: %v", scenario.name, err)
					}
				}
			}
			// Observing the edge query also proves the vertex read completed.
			cancel()
			select {
			case result := <-finished:
				drained = true
				var queryError *store.Error
				if !errors.Is(result.snapshot, context.Canceled) || !errors.Is(result.operation, context.Canceled) || !errors.As(result.operation, &queryError) || queryError.Phase != scenario.phase {
					t.Fatalf("%s cancellation lost its phase or cause: operation=%v snapshot=%v", scenario.name, result.operation, result.snapshot)
				}
			case <-bounded.Done():
				t.Fatal("canceled history directory query did not return")
			}
			for {
				var active bool
				if err := db.Pool.QueryRow(bounded, `SELECT coalesce((SELECT state='active' OR xact_start IS NOT NULL FROM pg_stat_activity WHERE pid=$1),false)`, reader).Scan(&active); err != nil {
					t.Fatal(err)
				}
				if !active && db.Pool.Stat().AcquiredConns() == 1 {
					break
				}
				if err := testutil.WaitThreadClock(bounded); err != nil {
					t.Fatalf("canceled %s query retained its connection: %v", scenario.name, err)
				}
			}
		})
	}
}

type cancelAfterHistoryEdgesTx struct {
	pgx.Tx
	queries int
	closed  bool
	cancel  context.CancelFunc
}

func (tx *cancelAfterHistoryEdgesTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := tx.Tx.Query(ctx, sql, args...)
	tx.queries++
	if err != nil || tx.queries != 2 {
		return rows, err
	}
	return &cancelAfterHistoryEdgesRows{Rows: rows, tx: tx}, nil
}

type cancelAfterHistoryEdgesRows struct {
	pgx.Rows
	tx *cancelAfterHistoryEdgesTx
}

func (rows *cancelAfterHistoryEdgesRows) Close() {
	rows.Rows.Close()
	rows.tx.closed = true
	rows.tx.cancel()
}

func TestHistoryDirectoryGroupsCancellationAfterReadingGraph(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	queryTask(t, db, project.ID, 10, model.TaskTodo)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, tx)
	wrapped := &cancelAfterHistoryEdgesTx{Tx: tx, cancel: cancel}
	_, err = pgsession.NewHistoryDirectory(wrapped).Groups(ctx, project.ID, nil, 2)
	if !wrapped.closed || wrapped.queries != 2 || !errors.Is(err, context.Canceled) {
		t.Fatalf("graph cancellation: closed=%t queries=%d err=%v", wrapped.closed, wrapped.queries, err)
	}
}

func TestHistoryDirectoryBoundedChainQuery(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	const count = 100
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,description,status)
 SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,$1,'History member','', 'done' FROM generate_series(100,199) i`, project.ID)
	mustQueryExec(t, db, `UPDATE tasks SET completed_at='2026-11-01T00:00:00Z' WHERE project_id=$1`, project.ID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external)
 SELECT $1,('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,('00000000-0000-4000-8000-'||lpad((i-1)::text,12,'0'))::uuid,false FROM generate_series(101,199) i`, project.ID)
	started := time.Now()
	if err := db.ReadHistoryDirectory(t.Context(), func(scope store.HistoryDirectoryScope) error {
		dao := scope.HistoryDirectoryDAO()
		groups, err := dao.Groups(t.Context(), project.ID, nil, 2)
		if err != nil {
			return err
		}
		if len(groups) != 1 || groups[0].MemberCount != count || groups[0].ID != queryID(100) {
			t.Fatalf("bounded chain groups: %+v", groups)
		}
		members, err := dao.RetentionMembers(t.Context(), project.ID, queryID(199))
		if err != nil {
			return err
		}
		if len(members) != count {
			t.Fatalf("chain members: %d", len(members))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("100-member chain group and retention queries: %s", time.Since(started))
}

func TestHistoryDirectoryUnavailableReceiptsPreserveReasons(t *testing.T) {
	db := isolatedStore(t)
	task, original := prepareArchiveSession(t, db)
	for _, scenario := range []struct {
		name                           string
		receiptReason, errorCode, want *string
	}{
		{name: "receipt", receiptReason: historyReason("recording_not_enabled"), errorCode: historyReason("ended_before_first_sample"), want: historyReason("recording_not_enabled")},
		{name: "archive status fallback", errorCode: historyReason("ended_before_first_sample"), want: historyReason("ended_before_first_sample")},
		{name: "unknown reason"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			id, finalization := uuid.NewString(), uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state)
 SELECT $2,project_id,task_id,$2,owner_user_id,$2,registration,NULL,'herdr','{"Envelope":{"executionGeneration":"2"},"Runs":[]}' FROM task_sessions WHERE id=$1`, original, id)
			mustQueryExec(t, db, `INSERT INTO session_archives(session_id,state,schema_version,finalization_id,receipt,error_code)
 VALUES($1,'unavailable',2,$2::uuid,jsonb_build_object('finalizationId',$2::uuid::text,'disposition','unavailable','reason',$3::text),$4)`, id, finalization, scenario.receiptReason, scenario.errorCode)
			read := func() string {
				t.Helper()
				var fence string
				if err := db.ReadHistoryDirectory(t.Context(), func(scope store.HistoryDirectoryScope) error {
					dao := scope.HistoryDirectoryDAO()
					var err error
					fence, err = dao.Fence(t.Context(), task.ProjectID)
					if err != nil {
						return err
					}
					rows, err := dao.Sessions(t.Context(), task.ProjectID, task.ID, nil, 20)
					if err != nil {
						return err
					}
					for _, row := range rows {
						if row.ID != id {
							continue
						}
						if row.Claim != id || row.State == nil || *row.State != "unavailable" || !reflect.DeepEqual(row.ArchiveReason, scenario.want) || len(row.Snapshot) != 0 || len(row.Terminal) != 0 {
							t.Fatalf("unavailable directory lost original disposition: %+v", row)
						}
						return nil
					}
					t.Fatal("unavailable Session omitted")
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				return fence
			}
			before := read()
			// A reason correction alone changes visible directory facts even when
			// the Session identity and archive disposition remain unchanged.
			next := "recording_not_enabled"
			if scenario.want != nil && *scenario.want == next {
				next = "ended_before_first_sample"
			}
			mustQueryExec(t, db, `UPDATE session_archives SET receipt=jsonb_set(receipt,'{reason}',to_jsonb($2::text)) WHERE session_id=$1`, id, next)
			scenario.want = &next
			if after := read(); before == after {
				t.Fatal("reason correction did not invalidate directory fence")
			}
		})
	}
}

func historyReason(value string) *string { return &value }
