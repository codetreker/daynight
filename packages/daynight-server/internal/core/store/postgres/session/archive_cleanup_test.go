package session_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveCleanupDatabaseFailuresPreserveOriginalOwnership(t *testing.T) {
	db := isolatedStore(t)
	for i, stage := range []string{"expire", "retire", "mark", "complete", "metadata"} {
		if !t.Run(stage, func(t *testing.T) {
			task, id := prepareArchiveSessionForProject(t, db, i+1)
			target, at := prepareCleanupArchive(t, db, task, id, "archive/"+id)
			ctx := t.Context()
			finishing := stage == "complete" || stage == "metadata"
			resource := uuid.NewString()
			if finishing {
				expireCleanup(t, db, target, at)
			} else {
				mustQueryExec(t, db, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,'{}')`, target.SessionID, resource)
				mustQueryExec(t, db, `INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id) VALUES($1,$2,'archive','original')`, target.SessionID, resource)
			}
			mustQueryExec(t, db, `CREATE FUNCTION refuse_cleanup_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'cleanup storage refused'; END$$`)
			event, table, tail := "BEFORE UPDATE", "session_archive_retention", "FOR EACH ROW WHEN (NEW.expired_at IS NOT NULL AND OLD.expired_at IS NULL)"
			switch stage {
			case "retire":
				event, table, tail = "BEFORE DELETE", "session_resource_references", "FOR EACH ROW"
			case "mark":
				table, tail = "session_resources", "FOR EACH ROW WHEN (NEW.gc_pending)"
			case "complete":
				tail = "FOR EACH ROW WHEN (NEW.cleaned_at IS NOT NULL)"
			case "metadata":
				event, table, tail = "BEFORE DELETE", "session_archive_chunks", "FOR EACH STATEMENT"
			}
			mustQueryExec(t, db, "CREATE TRIGGER refuse_cleanup_fixture "+event+" ON "+table+" "+tail+" EXECUTE FUNCTION refuse_cleanup_fixture()")
			t.Cleanup(func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if _, err := db.Pool.Exec(cleanup, `DROP TRIGGER refuse_cleanup_fixture ON `+table+`; DROP FUNCTION refuse_cleanup_fixture()`); err != nil {
					t.Fatal(err)
				}
				var removed bool
				err := db.Pool.QueryRow(cleanup, `SELECT to_regprocedure('refuse_cleanup_fixture()') IS NULL
 AND NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname='refuse_cleanup_fixture')`, table).Scan(&removed)
				if err != nil || !removed {
					t.Fatalf("Archive Cleanup fault objects retained: removed=%t error=%v", removed, err)
				}
			})
			// Caller-supplied lifecycle hints are not trusted scope facts.
			claimed := target
			claimed.ExpiredAt, claimed.CleanedAt = &at, &at
			completion, err := db.WriteArchiveCleanup(ctx, claimed, func(s store.ArchiveCleanupScope) error {
				observed := s.Target()
				if observed.ProjectID != target.ProjectID || observed.TaskID != target.TaskID || observed.SessionID != target.SessionID || observed.OwnerID != target.OwnerID || observed.CleanedAt != nil || (observed.ExpiredAt != nil) != finishing {
					t.Fatalf("scope trusted caller hints or changed ownership: %+v", observed)
				}
				if finishing {
					return s.CompleteArchiveCleanup(ctx, at)
				}
				retention, err := core.RefreshArchiveRetention(ctx, s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
				if err != nil {
					return err
				}
				return s.ExpireArchive(ctx, retention.Version, at)
			})
			var databaseError *pgconn.PgError
			if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &databaseError) || databaseError.Code != "P0001" || databaseError.Message != "cleanup storage refused" {
				t.Fatalf("lost database refusal: %+v %v", completion, err)
			}
			var expired, cleaned, pending bool
			var references int
			if err := db.Pool.QueryRow(ctx, `SELECT expired_at IS NOT NULL,cleaned_at IS NOT NULL,
 EXISTS(SELECT 1 FROM session_resources WHERE session_id=$1 AND gc_pending),
 (SELECT count(*) FROM session_resource_references WHERE session_id=$1)
 FROM session_archive_retention WHERE session_id=$1`, target.SessionID).Scan(&expired, &cleaned, &pending, &references); err != nil {
				t.Fatal(err)
			}
			wantReferences := 1
			if finishing {
				wantReferences = 0
			}
			if expired != finishing || cleaned || pending || references != wantReferences {
				t.Fatalf("failed cleanup changed durable ownership: expired=%v cleaned=%v pending=%v refs=%d", expired, cleaned, pending, references)
			}
		}) {
			return
		}
	}
}

func cleanupFixture(t *testing.T, db *postgres.Store) (store.ArchiveCleanupTarget, time.Time) {
	t.Helper()
	task, id := prepareArchiveSession(t, db)
	return prepareCleanupArchive(t, db, task, id, "archive/path")
}

func prepareCleanupArchive(t *testing.T, db *postgres.Store, task model.Task, id, archivePath string) (store.ArchiveCleanupTarget, time.Time) {
	t.Helper()
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	mustQueryExec(t, db, `UPDATE tasks SET completed_at=$2 WHERE id=$1`, task.ID, at)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		if err := d.SetSessionArchiveReady(t.Context(), id, archiveHashOf("archive"), 7, archivePath); err != nil {
			return err
		}
		return d.(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(t.Context(), id, at)
	})
	target := store.ArchiveCleanupTarget{ProjectID: task.ProjectID, TaskID: task.ID, SessionID: id}
	if err := db.Pool.QueryRow(t.Context(), `SELECT owner_user_id::text FROM task_sessions WHERE id=$1`, id).Scan(&target.OwnerID); err != nil {
		t.Fatal(err)
	}
	return target, at.Add(core.ArchiveRetentionPeriod)
}

func expireCleanup(t *testing.T, db *postgres.Store, target store.ArchiveCleanupTarget, at time.Time) {
	t.Helper()
	c, err := db.WriteArchiveCleanup(t.Context(), target, func(s store.ArchiveCleanupScope) error {
		r, err := core.RefreshArchiveRetention(t.Context(), s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
		if err != nil {
			return err
		}
		return s.ExpireArchive(t.Context(), r.Version, at)
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("expire: %+v %v", c, err)
	}
}

func TestArchiveCleanupExpirationAndReferenceOwnership(t *testing.T) {
	db := isolatedStore(t)
	target, at := cleanupFixture(t, db)
	ctx := t.Context()
	type resourceCase struct {
		name, extra           string
		knownCapture, pending bool
		id                    string
	}
	cases := []resourceCase{
		{name: "archive-only", pending: true},
		{name: "capture", knownCapture: true, pending: true},
		{name: "unknown-message", extra: "message"},
		{name: "shared-upload", extra: "upload", knownCapture: true},
		{name: "shared-operation", extra: "operation", knownCapture: true},
		{name: "shared-native", extra: "native_resume", knownCapture: true},
		{name: "shared-unknown", extra: "unknown", knownCapture: true},
		{name: "shared-blob-alias"},
	}
	for i := range cases {
		c := &cases[i]
		c.id = uuid.NewString()
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			media := d.(store.SessionResourceDAO)
			if err := media.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: target.SessionID, BlobID: c.id, BlobPath: "original/" + c.id, Resource: sp.Resource{ResourceID: c.id, Status: "available", Revision: "1"}}); err != nil {
				return err
			}
			if err := media.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: target.SessionID, ResourceID: c.id, Kind: "archive", ReferenceID: "original-archive"}); err != nil {
				return err
			}
			if c.extra != "" {
				return media.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: target.SessionID, ResourceID: c.id, Kind: c.extra, ReferenceID: "independent-owner"})
			}
			return nil
		})
		if c.knownCapture {
			image := uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO session_image_captures(session_id,capture_id,image_id,request,receipt) VALUES($1,$2,$3,'{}',jsonb_build_object('state','committed','resourceId',$4::text))`, target.SessionID, uuid.NewString(), image, c.id)
			mustQueryExec(t, db, `INSERT INTO session_resource_references VALUES($1,$2,'message',$3)`, target.SessionID, c.id, image)
		}
		if c.name == "shared-blob-alias" {
			alias := uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path)
 VALUES($1,$2,jsonb_build_object('resourceId',$2::uuid::text,'status','available'),$3,$4)`, target.SessionID, alias, c.id, "original/"+c.id)
			mustQueryExec(t, db, `INSERT INTO session_resource_references VALUES($1,$2,'unknown','independent-owner')`, target.SessionID, alias)
		}
	}
	// An interrupted transaction must retain both readability and all pins.
	abort := errors.New("abort expiration")
	c, err := db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error {
		r, err := core.RefreshArchiveRetention(ctx, s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
		if err != nil {
			return err
		}
		if err = s.ExpireArchive(ctx, r.Version, at); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var expired bool
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		var err error
		expired, err = d.(store.SessionArchiveExpiryDAO).SessionArchiveExpired(ctx, target.SessionID)
		return err
	})
	if expired {
		t.Fatal("rollback revoked readability")
	}
	expireCleanup(t, db, target, at)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		media := d.(store.SessionResourceDAO)
		for _, c := range cases {
			r, err := media.SavedSessionResource(ctx, target.SessionID, c.id)
			if err != nil {
				return err
			}
			if r.GCPending != c.pending {
				t.Fatalf("%s pending=%v", c.name, r.GCPending)
			}
			count, err := media.SessionResourceReferenceCount(ctx, target.SessionID, c.id)
			if err != nil {
				return err
			}
			want := 0
			if c.extra != "" {
				want = 1
			}
			if count != want {
				t.Fatalf("%s references=%d want=%d", c.name, count, want)
			}
		}
		return nil
	})
	// Failed physical deletion leaves the durable candidate available on restart.
	_, err = db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error { return s.CompleteArchiveCleanup(ctx, at) })
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_busy" {
		t.Fatalf("premature completion: %v", err)
	}
	page, err := db.ListArchiveCleanup(ctx, "", 100)
	if err != nil || len(page) != 1 || page[0].ExpiredAt == nil || page[0].CleanedAt != nil {
		t.Fatalf("pending cleanup: %+v %v", page, err)
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		settle := d.(store.SessionResourceSettlementDAO)
		for _, c := range cases {
			if c.pending {
				if err := settle.DeleteReclaimedSessionResource(ctx, target.SessionID, c.id); err != nil {
					return err
				}
			}
		}
		return nil
	})
	c, err = db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error { return s.CompleteArchiveCleanup(ctx, at) })
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("complete: %+v %v", c, err)
	}
	page, err = db.ListArchiveCleanup(ctx, "", 100)
	if err != nil || len(page) != 0 {
		t.Fatalf("completed cleanup remains: %+v %v", page, err)
	}
	// The expiry tombstone survives completion and new Task activity.
	mustQueryExec(t, db, `UPDATE tasks SET status='in_progress',completed_at=NULL WHERE id=$1`, target.TaskID)
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		var err error
		expired, err = d.(store.SessionArchiveExpiryDAO).SessionArchiveExpired(ctx, target.SessionID)
		return err
	})
	if !expired {
		t.Fatal("completed cleanup lost expiry tombstone")
	}
}

func TestArchiveCleanupConditionalExpirationAndIdentity(t *testing.T) {
	db := isolatedStore(t)
	target, at := cleanupFixture(t, db)
	ctx := t.Context()
	for _, scenario := range []string{"early", "version", "unavailable", "unknown-deadline"} {
		t.Run(scenario, func(t *testing.T) {
			_, err := db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error {
				r, err := core.RefreshArchiveRetention(ctx, s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
				if err != nil {
					return err
				}
				when := at
				switch scenario {
				case "early":
					when = at.Add(-time.Nanosecond)
				case "version":
					r.Version++
				case "unavailable":
					// Schema3 permits incomplete archive receipts without legacy body
					// constraints. The ready publication retains the same Session lock.
					if err = s.SessionDAO().(store.SessionArchiveDAO).SetUnifiedSessionArchiveReady(ctx, target.SessionID, archiveHashOf("archive"), 7, "archive/path", "complete"); err != nil {
						return err
					}
					if err = s.SessionDAO().SetSessionArchiveState(ctx, target.SessionID, "failed", nil); err != nil {
						return err
					}
				case "unknown-deadline":
					r.ExpiresAt = nil
					r, err = s.RetentionDAO().SaveArchiveRetention(ctx, r.Version, r)
					if err != nil {
						return err
					}
				}
				return s.ExpireArchive(ctx, r.Version, when)
			})
			var f *model.Fault
			if !errors.As(err, &f) || f.Code != "version_conflict" {
				t.Fatalf("%s admitted: %v", scenario, err)
			}
		})
	}
	wrong := target
	wrong.OwnerID = uuid.NewString()
	_, err := db.WriteArchiveCleanup(ctx, wrong, func(store.ArchiveCleanupScope) error { t.Fatal("wrong owner admitted"); return nil })
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("owner mismatch: %v", err)
	}
	for _, limit := range []int{0, 101} {
		if _, err = db.ListArchiveCleanup(ctx, "", limit); err == nil {
			t.Fatal("invalid page limit admitted")
		}
	}
	if _, err = db.ListArchiveCleanup(ctx, "invalid", 1); err == nil {
		t.Fatal("invalid cursor admitted")
	}
	expireCleanup(t, db, target, at)
	_, err = db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error { return s.ExpireArchive(ctx, 1, at) })
	if err == nil {
		t.Fatal("expired archive admitted twice")
	}
}

func TestArchiveCleanupPaginationAndLeaseBarrier(t *testing.T) {
	db := isolatedStore(t)
	target, at := cleanupFixture(t, db)
	ctx := t.Context()
	second := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) SELECT $2,project_id,task_id,$2,owner_user_id,$2,registration,snapshot FROM task_sessions WHERE id=$1`, target.SessionID, second)
	mustQueryExec(t, db, `INSERT INTO session_archive_retention(session_id) VALUES($1)`, second)
	firstPage, err := db.ListArchiveCleanup(ctx, "", 1)
	if err != nil || len(firstPage) != 1 {
		t.Fatal(firstPage, err)
	}
	nextPage, err := db.ListArchiveCleanup(ctx, firstPage[0].SessionID, 1)
	if err != nil || len(nextPage) != 1 || nextPage[0].SessionID == firstPage[0].SessionID {
		t.Fatal(nextPage, err)
	}
	lastPage, err := db.ListArchiveCleanup(ctx, nextPage[0].SessionID, 1)
	if err != nil || len(lastPage) != 0 {
		t.Fatal(lastPage, err)
	}
	expireCleanup(t, db, target, at)
	lease := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO session_resource_leases(session_id,lease_id,owner_id,kind,delete_epoch) VALUES($1,$2,$3,'read',0)`, target.SessionID, lease, target.OwnerID)
	_, err = db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error { return s.CompleteArchiveCleanup(ctx, at) })
	if err == nil {
		t.Fatal("reader lease bypassed")
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		return d.(store.SessionResourceDAO).ReleaseSessionResourceLease(ctx, target.SessionID, lease)
	})
	_, err = db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error { return s.CompleteArchiveCleanup(ctx, at) })
	if err != nil {
		t.Fatal(err)
	}
}

func TestArchiveCleanupWaitsForReopenCommit(t *testing.T) {
	db := isolatedStore(t)
	target, _ := cleanupFixture(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err = blocker.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, target.ProjectID); err != nil {
		t.Fatal(err)
	}
	if _, err = blocker.Exec(ctx, `UPDATE tasks SET status='in_progress',completed_at=NULL,version=version+1 WHERE id=$1`, target.TaskID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error {
			r, err := core.RefreshArchiveRetention(ctx, s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
			if err == nil && (r.ExpiresAt != nil || r.Reason != "chain_unfinished") {
				err = errors.New("cleanup observed old terminal state")
			}
			return err
		})
		done <- err
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT p.id::text FROM projects p WHERE p.id=$1", blocker.Conn().PgConn().PID())
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}

func TestArchiveCleanupWaitsForDependencyGraphCommit(t *testing.T) {
	for _, detach := range []bool{false, true} {
		name := "attach unfinished member"
		if detach {
			name = "detach unfinished member"
		}
		t.Run(name, func(t *testing.T) {
			db := isolatedStore(t)
			target, at := cleanupFixture(t, db)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			member := queryTask(t, db, target.ProjectID, 3, model.TaskTodo)
			if detach {
				mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, target.ProjectID, target.TaskID, member.ID)
			}
			var cached store.ArchiveRetention
			completion, err := db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error {
				var err error
				cached, err = core.RefreshArchiveRetention(ctx, s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted || (cached.ExpiresAt == nil) != detach {
				t.Fatalf("initial graph deadline: %+v %+v %v", cached, completion, err)
			}
			blocker, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err = blocker.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, target.ProjectID); err != nil {
				t.Fatal(err)
			}
			mutation := `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`
			if detach {
				mutation = `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND depends_on_task_id=$3`
			}
			if _, err = blocker.Exec(ctx, mutation, target.ProjectID, target.TaskID, member.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = blocker.Exec(ctx, `UPDATE tasks SET version=version+1 WHERE id=$1`, target.TaskID); err != nil {
				t.Fatal(err)
			}
			type result struct {
				retention  store.ArchiveRetention
				completion store.Completion
				err        error
			}
			done := make(chan result, 1)
			go func() {
				var out result
				out.completion, out.err = db.WriteArchiveCleanup(ctx, target, func(s store.ArchiveCleanupScope) error {
					var err error
					out.retention, err = core.RefreshArchiveRetention(ctx, s.RetentionDAO(), target.ProjectID, target.TaskID, target.SessionID)
					if err != nil {
						return err
					}
					if out.retention.ExpiresAt != nil && !at.Before(*out.retention.ExpiresAt) {
						return s.ExpireArchive(ctx, out.retention.Version, at)
					}
					return nil
				})
				done <- out
			}()
			joined := false
			defer func() {
				cancel()
				_ = blocker.Rollback(context.Background())
				if !joined {
					<-done
				}
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT p.id::text FROM projects p WHERE p.id=$1", blocker.Conn().PgConn().PID())
			if err = blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			out := <-done
			joined = true
			if out.err != nil || out.completion.Outcome != store.TransactionCommitted {
				t.Fatalf("graph cleanup: %+v %v", out.completion, out.err)
			}
			wantMembers := 2
			wantReason := "chain_unfinished"
			if detach {
				wantMembers, wantReason = 1, "scheduled"
			}
			if len(out.retention.Members) != wantMembers || out.retention.Reason != wantReason || (out.retention.ExpiresAt != nil) != detach {
				t.Fatalf("cleanup used cached graph: %+v", out.retention)
			}
			foundMember := false
			for _, current := range out.retention.Members {
				if current.TaskID == target.TaskID && current.Version != cached.Members[0].Version+1 {
					t.Fatalf("cleanup missed graph owner's version: %+v", current)
				}
				if current.TaskID == member.ID {
					foundMember = true
					if current.Status != string(model.TaskTodo) || current.Version != member.Version {
						t.Fatalf("new graph member facts: %+v", current)
					}
				}
			}
			if foundMember == detach {
				t.Fatalf("cleanup retained the wrong chain: %+v", out.retention.Members)
			}
			var expired bool
			sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
				var err error
				expired, err = d.(store.SessionArchiveExpiryDAO).SessionArchiveExpired(ctx, target.SessionID)
				return err
			})
			if expired != detach {
				t.Fatalf("persisted expiration ignored graph change: expired=%v detach=%v", expired, detach)
			}
		})
	}
}
