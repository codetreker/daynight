package postgres

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

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
	if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted || failure.Outcome != store.TransactionUnknown || !databaseFailure {
		t.Fatalf("lost confirmation: lost=%v completion=%+v transaction=%+v error=%v", lost.Load(), completion, failure, err)
	}
	var role string
	var version int64
	if err := s.Pool.QueryRow(ctx, `SELECT role,version FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, target.UserID).Scan(&role, &version); err != nil || role != "admin" || version <= 0 {
		t.Fatalf("independent committed grant: role=%s version=%d error=%v", role, version, err)
	}
}
