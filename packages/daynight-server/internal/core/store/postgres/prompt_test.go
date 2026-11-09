package postgres

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestPromptCASAndSnapshot(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	user, id := uuid.NewString(), uuid.NewString()
	write := func(text string, expected int64) error {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			if expected == 0 {
				_, err := tx.CreatePrompt(ctx, user, model.PromptScopeProject, id, text)
				return err
			}
			_, err := tx.UpdatePrompt(ctx, user, model.PromptScopeProject, id, expected+1, expected, text)
			return err
		})
		return err
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, text := range []string{"one", "two"} {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- write(text, 0) }()
	}
	wg.Wait()
	close(errs)
	wins, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			wins++
			continue
		}
		var fault *model.Fault
		if errors.As(err, &fault) && fault.Code == "version_conflict" {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("create outcomes %d %d", wins, conflicts)
	}
	err := NewPrompt(db.Pool).ReadPromptSnapshot(ctx, func(s PromptSnapshot) error {
		m, err := s.PromptMetadata(ctx, user, model.PromptScopeProject, id)
		if err != nil {
			return err
		}
		if m.Revision != 1 {
			t.Fatalf("revision: %+v", m)
		}
		before, err := s.PromptText(ctx, user, model.PromptScopeProject, id)
		if err != nil {
			return err
		}
		if err := write("new", 1); err != nil {
			return err
		}
		after, err := s.PromptText(ctx, user, model.PromptScopeProject, id)
		if before != after {
			t.Fatalf("snapshot changed %q to %q", before, after)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := write("stale", 1); err == nil {
		t.Fatal("stale update succeeded")
	}
	if err := write("", 2); err != nil {
		t.Fatal(err)
	}
	if err := write("again", 3); err != nil {
		t.Fatal(err)
	}
	err = NewPrompt(db.Pool).ReadPromptSnapshot(ctx, func(s PromptSnapshot) error {
		m, e := s.PromptMetadata(ctx, user, model.PromptScopeProject, id)
		if m.Revision != 4 {
			t.Fatalf("ABA revision: %+v", m)
		}
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	updates := make(chan error, 2)
	for _, text := range []string{"winner-a", "winner-b"} {
		wg.Add(1)
		go func() { defer wg.Done(); updates <- write(text, 4) }()
	}
	wg.Wait()
	close(updates)
	wins, conflicts = 0, 0
	for err := range updates {
		if err == nil {
			wins++
			continue
		}
		var f *model.Fault
		if errors.As(err, &f) && f.Code == "version_conflict" {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("update outcomes %d %d", wins, conflicts)
	}
}
func TestPromptProjectLockBlocksRevocation(t *testing.T) {
	db, principal, _, project := promptFixture(t)
	ctx := context.Background()
	locked := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, principal, project.ID); err != nil {
				return err
			}
			close(locked)
			<-release
			return nil
		})
		done <- err
	}()
	<-locked
	wait, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	_, err := db.Pool.Exec(wait, `DELETE FROM team_members WHERE user_id=$1`, principal.UserID)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("revocation did not wait: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestPromptDirectGrantLockAndRecheck(t *testing.T) {
	db, _, member, project := promptFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)
	held, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			close(held)
			<-release
			_, err := tx.CreatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, "member text")
			return err
		})
		done <- err
	}()
	<-held
	revoker, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoker.Release()
	revokeDone := make(chan error, 1)
	go func() {
		_, err := revoker.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID)
		revokeDone <- err
	}()
	waitThreadBackendLock(t, db, revoker.Conn().PgConn().PID())
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := <-revokeDone; err != nil {
		t.Fatal(err)
	}
	var value string
	if err := db.Pool.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope='project' AND scope_id=$2`, member.UserID, project.ID).Scan(&value); err != nil || value != "member text" {
		t.Fatalf("member write: %q %v", value, err)
	}
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)
	revoking, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoking.Rollback(context.Background())
	if _, err = revoking.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	pid := make(chan uint32, 1)
	result := make(chan error, 1)
	go func() {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			pid <- tx.(*promptTx).tx.Conn().PgConn().PID()
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			_, err := tx.UpdatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, 2, 1, "unauthorized")
			return err
		})
		result <- err
	}()
	waitThreadBackendLock(t, db, <-pid)
	if err = revoking.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("authorization after revoke: %v", err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope='project' AND scope_id=$2`, member.UserID, project.ID).Scan(&value); err != nil || value != "member text" {
		t.Fatalf("revoked write: %q %v", value, err)
	}
}

func TestPromptOwnershipLockAndRecheck(t *testing.T) {
	db, _, member, project := promptFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	teamA, teamB := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO teams(id,name) VALUES($1,'A'),($2,'B')`, teamA, teamB)
	mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, teamA, member.UserID)
	mustQueryExec(t, db, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, teamA)
	held, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			close(held)
			<-release
			_, err := tx.CreatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, "team member")
			return err
		})
		done <- err
	}()
	<-held
	mover, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer mover.Release()
	moved := make(chan error, 1)
	go func() {
		_, err := mover.Exec(ctx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, teamB)
		moved <- err
	}()
	waitThreadBackendLock(t, db, mover.Conn().PgConn().PID())
	close(release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	if err = <-moved; err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, teamA)
	moving, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer moving.Rollback(context.Background())
	if _, err = moving.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = moving.Exec(ctx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, teamB); err != nil {
		t.Fatal(err)
	}
	pid := make(chan uint32, 1)
	result := make(chan error, 1)
	go func() {
		_, err := NewPrompt(db.Pool).WritePrompt(ctx, func(tx PromptWriteScope) error {
			pid <- tx.(*promptTx).tx.Conn().PgConn().PID()
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			_, err := tx.UpdatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, 2, 1, "unauthorized")
			return err
		})
		result <- err
	}()
	waitThreadBackendLock(t, db, <-pid)
	if err = moving.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("authorization after transfer: %v", err)
	}
	var value string
	if err = db.Pool.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope='project' AND scope_id=$2`, member.UserID, project.ID).Scan(&value); err != nil || value != "team member" {
		t.Fatalf("transferred write: %q %v", value, err)
	}
}

func TestPromptMigrationSchema(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	rows, err := db.Pool.Query(ctx, `SELECT attname,format_type(atttypid,atttypmod),attnotnull FROM pg_attribute WHERE attrelid='worker_prompts'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)
	if err != nil {
		t.Fatal(err)
	}
	type column struct {
		name, typ string
		notNull   bool
	}
	var got []column
	for rows.Next() {
		var c column
		if err := rows.Scan(&c.name, &c.typ, &c.notNull); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		t.Fatal(err)
	}
	want := []column{{"user_id", "uuid", true}, {"scope", "text", true}, {"scope_id", "uuid", true}, {"revision", "bigint", true}, {"prompt_text", "text", true}, {"updated_at", "timestamp with time zone", true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("columns: %#v", got)
	}
	var primary string
	err = db.Pool.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='worker_prompts'::regclass AND contype='p'`).Scan(&primary)
	if err != nil || primary != "PRIMARY KEY (user_id, scope, scope_id)" {
		t.Fatalf("primary key %q %v", primary, err)
	}
	var count int
	err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM worker_prompts`).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("new table rows %d %v", count, err)
	}
}

func mustQueryExec(t *testing.T, db *Store, sql string, args ...any) {
	t.Helper()
	if _, err := db.Pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func promptFixture(t *testing.T) (*Store, model.Principal, model.Principal, model.Project) {
	t.Helper()
	db := searchTestStore(t)
	admin, member, project, team := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,now(),now()),($2::uuid,($2::uuid)::text,now(),now())`, admin, member)
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','https://example.com')`, project)
	mustQueryExec(t, db, `INSERT INTO teams(id,name) VALUES($1,'Owner')`, team)
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, admin)
	return db, model.Principal{UserID: admin}, model.Principal{UserID: member}, model.Project{ID: project}
}
func waitThreadBackendLock(t *testing.T, db *Store, pid uint32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		err := db.Pool.QueryRow(context.Background(), `SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("backend did not wait for a lock")
}
