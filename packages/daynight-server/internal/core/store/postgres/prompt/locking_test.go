package prompt_test

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"sync"
	"testing"
	"time"
)

type Store = postgres.Store
type promptTx struct {
	PromptWriteScope
	tx pgx.Tx
}

func promptWrite(ctx context.Context, db *Store, fn func(PromptWriteScope) error) (Completion, error) {
	tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{}, err
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(c)
	}()
	if err = fn(&promptTx{PromptWriteScope: prompt.NewDAO(tx), tx: tx}); err != nil {
		return Completion{Outcome: TransactionNotCommitted}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Completion{Outcome: TransactionUnknown}, err
	}
	return Completion{Outcome: TransactionCommitted}, nil
}
func searchTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := postgres.Open(context.Background(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db
}
func mustQueryExec(t *testing.T, db *Store, sql string, args ...any) {
	t.Helper()
	if _, err := db.Pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}
func waitThreadBackendLock(t *testing.T, db *Store, pid uint32) {
	t.Helper()
	testutil.WaitThreadBackendLock(t, db.Pool, pid)
}
func TestPromptProjectLockBlocksRevocation(t *testing.T) {
	db, principal, _, project := promptFixture(t)
	group := newPromptGroup(t)
	ctx := group.ctx
	locked := make(chan struct{})
	release := group.signal
	done := make(chan error, 1)
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, principal, project.ID); err != nil {
				return err
			}
			close(locked)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return nil
		})
		done <- err
	})
	waitPromptHeld(t, ctx, locked, done)
	wait, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	_, err := db.Pool.Exec(wait, `DELETE FROM team_members WHERE user_id=$1`, principal.UserID)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("revocation did not wait: %v", err)
	}
	group.release()
	if err := waitPromptResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
}

func TestPromptDirectGrantLockAndRecheck(t *testing.T) {
	db, _, member, project := promptFixture(t)
	group := newPromptGroup(t)
	ctx := group.ctx
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)
	held, release, done := make(chan struct{}), group.signal, make(chan error, 1)
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			close(held)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err := tx.CreatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, "member text")
			return err
		})
		done <- err
	})
	waitPromptHeld(t, ctx, held, done)
	revoker, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	group.after(revoker.Release)
	revokeDone := make(chan error, 1)
	group.start(func() {
		_, err := revoker.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID)
		revokeDone <- err
	})
	waitThreadBackendLock(t, db, revoker.Conn().PgConn().PID())
	group.release()
	if err := waitPromptResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
	if err := waitPromptResult(t, ctx, revokeDone); err != nil {
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
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			pid <- tx.(*promptTx).tx.Conn().PgConn().PID()
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			_, err := tx.UpdatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, 2, 1, "unauthorized")
			return err
		})
		result <- err
	})
	waitThreadBackendLock(t, db, waitPromptPID(t, ctx, pid, result))
	if err = revoking.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = waitPromptResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("authorization after revoke: %v", err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope='project' AND scope_id=$2`, member.UserID, project.ID).Scan(&value); err != nil || value != "member text" {
		t.Fatalf("revoked write: %q %v", value, err)
	}
}

func TestPromptOwnershipLockAndRecheck(t *testing.T) {
	db, _, member, project := promptFixture(t)
	group := newPromptGroup(t)
	ctx := group.ctx
	teamA, teamB := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO teams(id,name) VALUES($1,'A'),($2,'B')`, teamA, teamB)
	mustQueryExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, teamA, member.UserID)
	mustQueryExec(t, db, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, teamA)
	held, release, done := make(chan struct{}), group.signal, make(chan error, 1)
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			close(held)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err := tx.CreatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, "team member")
			return err
		})
		done <- err
	})
	waitPromptHeld(t, ctx, held, done)
	mover, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	group.after(mover.Release)
	moved := make(chan error, 1)
	group.start(func() {
		_, err := mover.Exec(ctx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, teamB)
		moved <- err
	})
	waitThreadBackendLock(t, db, mover.Conn().PgConn().PID())
	group.release()
	if err = waitPromptResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
	if err = waitPromptResult(t, ctx, moved); err != nil {
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
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			pid <- tx.(*promptTx).tx.Conn().PgConn().PID()
			if err := tx.LockPromptProject(ctx, member, project.ID); err != nil {
				return err
			}
			_, err := tx.UpdatePrompt(ctx, member.UserID, model.PromptScopeProject, project.ID, 2, 1, "unauthorized")
			return err
		})
		result <- err
	})
	waitThreadBackendLock(t, db, waitPromptPID(t, ctx, pid, result))
	if err = moving.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = waitPromptResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("authorization after transfer: %v", err)
	}
	var value string
	if err = db.Pool.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope='project' AND scope_id=$2`, member.UserID, project.ID).Scan(&value); err != nil || value != "team member" {
		t.Fatalf("transferred write: %q %v", value, err)
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

func TestPromptProjectDeletionWaitsAndRechecks(t *testing.T) {
	db, principal, _, project := promptFixture(t)
	group := newPromptGroup(t)
	ctx := group.ctx
	held, release, done := make(chan struct{}), group.signal, make(chan error, 1)
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			if err := tx.LockPromptProject(ctx, principal, project.ID); err != nil {
				return err
			}
			close(held)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			_, err := tx.CreatePrompt(ctx, principal.UserID, model.PromptScopeProject, project.ID, "prior")
			return err
		})
		done <- err
	})
	waitPromptHeld(t, ctx, held, done)
	deleter, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	group.after(deleter.Release)
	deleted := make(chan error, 1)
	group.start(func() {
		_, err := deleter.Exec(ctx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, project.ID)
		deleted <- err
	})
	waitThreadBackendLock(t, db, deleter.Conn().PgConn().PID())
	group.release()
	if err = waitPromptResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
	if err = waitPromptResult(t, ctx, deleted); err != nil {
		t.Fatal(err)
	}
	err = db.ReadPromptSnapshot(ctx, func(snapshot PromptSnapshot) error {
		_, err := snapshot.ProjectAccess(ctx, principal, project.ID)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted project readable: %v", err)
	}
	mustQueryExec(t, db, `UPDATE projects SET deleted_at=NULL WHERE id=$1`, project.ID)
	deleting, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deleting.Rollback(context.Background())
	if _, err = deleting.Exec(ctx, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, project.ID); err != nil {
		t.Fatal(err)
	}
	pid := make(chan uint32, 1)
	result := make(chan error, 1)
	group.start(func() {
		_, err := promptWrite(ctx, db, func(tx PromptWriteScope) error {
			pid <- tx.(*promptTx).tx.Conn().PgConn().PID()
			if err := tx.LockPromptProject(ctx, principal, project.ID); err != nil {
				return err
			}
			_, err := tx.UpdatePrompt(ctx, principal.UserID, model.PromptScopeProject, project.ID, 2, 1, "unauthorized")
			return err
		})
		result <- err
	})
	waitThreadBackendLock(t, db, waitPromptPID(t, ctx, pid, result))
	if err = deleting.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = waitPromptResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("authorization after delete: %v", err)
	}
	var value string
	if err = db.Pool.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope='project' AND scope_id=$2`, principal.UserID, project.ID).Scan(&value); err != nil || value != "prior" {
		t.Fatalf("deleted project write: %q %v", value, err)
	}
}

// promptGroup cancels and drains every owned operation before pooled resources close.
type promptGroup struct {
	ctx        context.Context
	cancel     context.CancelFunc
	signal     chan struct{}
	once       sync.Once
	wg         sync.WaitGroup
	finalizers []func()
}

func newPromptGroup(t *testing.T) *promptGroup {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	g := &promptGroup{ctx: ctx, cancel: cancel, signal: make(chan struct{})}
	t.Cleanup(func() {
		g.cancel()
		g.release()
		g.wg.Wait()
		for _, f := range g.finalizers {
			f()
		}
	})
	return g
}
func (g *promptGroup) start(f func()) { g.wg.Add(1); go func() { defer g.wg.Done(); f() }() }
func (g *promptGroup) release()       { g.once.Do(func() { close(g.signal) }) }
func (g *promptGroup) after(f func()) { g.finalizers = append(g.finalizers, f) }
func waitPromptHeld(t *testing.T, ctx context.Context, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatalf("writer ended before lock: %v", err)
	case <-ctx.Done():
		t.Fatalf("lock wait: %v", ctx.Err())
	}
}
func waitPromptPID(t *testing.T, ctx context.Context, pid <-chan uint32, done <-chan error) uint32 {
	t.Helper()
	select {
	case p := <-pid:
		return p
	case err := <-done:
		t.Fatalf("writer ended before start: %v", err)
	case <-ctx.Done():
		t.Fatalf("writer start: %v", ctx.Err())
	}
	return 0
}
func waitPromptResult(t *testing.T, ctx context.Context, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		t.Fatalf("operation wait: %v", ctx.Err())
	}
	return nil
}
