package postgres

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProjectDirectMemberScopeResults(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, _, target, p := membershipFixture(t)
	ctx := t.Context()
	called := false
	callback := func(store.ProjectDirectMemberScope) error { called = true; return nil }
	c, err := db.WriteProjectDirectMember(ctx, uuid.NewString(), callback)
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) || called {
		t.Fatalf("missing project: %+v %v called=%t", c, err, called)
	}
	c, err = db.WriteProjectDirectMember(ctx, "malformed", callback)
	failed, _ := store.DatabaseErrorFacts(err)
	if c.Outcome != store.TransactionNotCommitted || !failed || called {
		t.Fatalf("invalid database input: %+v %v", c, err)
	}
	orphan := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Orphan','https://example.test/orphan')`, orphan)
	c, err = db.WriteProjectDirectMember(ctx, orphan, callback)
	if c.Outcome != store.TransactionNotCommitted || err == nil || !strings.Contains(errChainText(err), "project ownership is missing") || called {
		t.Fatalf("missing ownership: %+v %v", c, err)
	}
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, orphan, uuid.NewString())
	c, err = db.WriteProjectDirectMember(ctx, orphan, callback)
	if c.Outcome != store.TransactionNotCommitted || err == nil || !strings.Contains(errChainText(err), "project owner Team is missing") || called {
		t.Fatalf("missing Team: %+v %v", c, err)
	}
	cause := errors.New("abort after grant")
	c, err = db.WriteProjectDirectMember(ctx, p.ID, func(s store.ProjectDirectMemberScope) error {
		if _, e := s.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectMemberRole); e != nil {
			return e
		}
		return cause
	})
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, cause) {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, p.ID, target.UserID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback persisted %d %v", count, err)
	}
	c, err = db.WriteProjectDirectMember(ctx, p.ID, func(s store.ProjectDirectMemberScope) error {
		if e := s.DirectMemberDAO().LockUser(ctx, target.UserID); e != nil {
			return e
		}
		_, e := s.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectMemberRole)
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("commit %+v %v", c, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2 AND role='member'`, p.ID, target.UserID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("commit persisted %d %v", count, err)
	}
	closed := closedStore(t)
	c, err = closed.WriteProjectDirectMember(ctx, p.ID, callback)
	if err == nil || c.Outcome != store.TransactionNotCommitted || called {
		t.Fatalf("closed pool %+v %v", c, err)
	}
}

func errChainText(err error) string {
	if err == nil {
		return ""
	}
	if multi, ok := err.(interface{ Unwrap() []error }); ok {
		var out string
		for _, e := range multi.Unwrap() {
			out += errChainText(e)
		}
		return err.Error() + out
	}
	return err.Error() + errChainText(errors.Unwrap(err))
}

func TestProjectDirectMemberScopeCancelsRootLockWaits(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, tc := range []struct{ name, table, prefix string }{
		{"project", "projects", "SELECT id::text FROM projects"},
		{"ownership", "project_ownership", "SELECT team_id::text FROM project_ownership"},
		{"team", "teams", "SELECT id::text FROM teams"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, _, _, p := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, `LOCK TABLE `+tc.table+` IN ACCESS EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			query, stop := context.WithCancel(ctx)
			defer stop()
			done := make(chan error, 1)
			go func() {
				c, e := db.WriteProjectDirectMember(query, p.ID, func(store.ProjectDirectMemberScope) error { return errors.New("unexpected callback") })
				if c.Outcome == store.TransactionCommitted {
					done <- errors.New("canceled operation reported commit")
					return
				}
				done <- e
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, tc.prefix, holder.Conn().PgConn().PID())
			stop()
			select {
			case e := <-done:
				if !errors.Is(e, context.Canceled) {
					t.Fatalf("cancellation: %v", e)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if err = holder.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			testutil.AssertPoolReusable(t, db.Pool)
		})
	}
}

func TestProjectDirectMemberWireCommitLoss(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, actor, target, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	var armed, lost atomic.Bool
	config := db.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	armed.Store(true)
	service := projectservice.NewDirectMembers(&Store{Pool: pool}, "https://example.test/api/v1")
	result, err := service.AddExistingMember(ctx, actor, project.ID, target.UserID, actor.UserID)
	var failure *store.TransactionError
	databaseFailure, _ := store.DatabaseErrorFacts(err)
	if !reflect.DeepEqual(result, core.ExistingMemberResult{}) || !lost.Load() || !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted || failure.Outcome != store.TransactionUnknown || !databaseFailure {
		t.Fatalf("lost confirmation: result=%+v lost=%t transaction=%+v error=%v", result, lost.Load(), failure, err)
	}
	var role string
	var version int64
	var inherited bool
	if err := db.Pool.QueryRow(ctx, `SELECT g.role,g.version,EXISTS(SELECT 1 FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1 AND m.user_id=$2) FROM project_grants g WHERE g.project_id=$1 AND g.user_id=$2`, project.ID, target.UserID).Scan(&role, &version, &inherited); err != nil || role != "member" || version <= 0 || inherited {
		t.Fatalf("independent read: role=%s version=%d inherited=%t error=%v", role, version, inherited, err)
	}
}

// We discard CommandComplete only after PostgreSQL confirms COMMIT on the wire;
// the driver must classify the missing confirmation without undoing durable data.
type lostGrantCommitConn struct {
	net.Conn
	armed   *atomic.Bool
	lost    *atomic.Bool
	pending bool
	buffer  []byte
}

func (c *lostGrantCommitConn) Write(data []byte) (int, error) {
	if c.armed.Load() && bytes.Contains(bytes.ToLower(data), []byte("commit\x00")) {
		c.pending = true
	}
	return c.Conn.Write(data)
}

func (c *lostGrantCommitConn) Read(out []byte) (int, error) {
	if len(c.buffer) > 0 {
		n := copy(out, c.buffer)
		c.buffer = c.buffer[n:]
		return n, nil
	}
	if !c.pending {
		return c.Conn.Read(out)
	}
	var header [5]byte
	if _, err := io.ReadFull(c.Conn, header[:]); err != nil {
		return 0, err
	}
	length := int(binary.BigEndian.Uint32(header[1:]))
	if length < 4 || length > 1024*1024 {
		return 0, errors.New("invalid PostgreSQL response frame")
	}
	payload := make([]byte, length-4)
	if _, err := io.ReadFull(c.Conn, payload); err != nil {
		return 0, err
	}
	if header[0] == 'C' && bytes.Equal(payload, []byte("COMMIT\x00")) {
		c.lost.Store(true)
		_ = c.Conn.Close()
		return 0, io.EOF
	}
	c.buffer = append(header[:], payload...)
	n := copy(out, c.buffer)
	c.buffer = c.buffer[n:]
	return n, nil
}

func TestGrantWireCommitLossPreservesUnknownAndDurableWrite(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, _, target, project := membershipFixture(t)
	ctx := t.Context()
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, project.Ownership.TeamID, target.UserID)
	var armed, lost atomic.Bool
	config := s.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	armed.Store(true)
	completion, err := (&Store{Pool: pool}).WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		_, err := scope.ProjectDAO().CreateGrant(ctx, target.UserID, model.ProjectAdmin)
		return err
	})
	var failure *store.TransactionError
	databaseFailure, _ := store.DatabaseErrorFacts(err)
	if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted || failure.Outcome != store.TransactionUnknown || failure.CleanupFailed || !databaseFailure {
		t.Fatalf("lost confirmation: lost=%v completion=%+v transaction=%+v error=%v", lost.Load(), completion, failure, err)
	}
	var role string
	var version int64
	if err := s.Pool.QueryRow(ctx, `SELECT role,version FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, target.UserID).Scan(&role, &version); err != nil || role != "admin" || version <= 0 {
		t.Fatalf("independent committed grant: role=%s version=%d error=%v", role, version, err)
	}
	if err := s.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		member, err := snapshot.ProjectDAO().DirectProjectMember(ctx, target.UserID, project.ID)
		if err == nil && (member.Grant.Role != model.ProjectAdmin || member.Grant.Version != version) {
			t.Fatalf("committed grant through snapshot: %#v", member.Grant)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}
