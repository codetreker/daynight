package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This test-only connection loses the COMMIT reply only after PostgreSQL sends
// CommandComplete, proving that the server committed before the client fails.
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

func TestGrantHTTPCommitLossReportsUnknownAfterRealCommit(t *testing.T) {
	h := membershipTestHarness(t)
	ctx := context.Background()
	if _, err := h.database.Pool.Exec(ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, h.project.Ownership.TeamID, h.memberID); err != nil {
		t.Fatal(err)
	}
	var armed, lost atomic.Bool
	config := h.database.Pool.Config().Copy()
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
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	mux := http.NewServeMux()
	NewMembershipRoutes(service.NewMemberships(&store.Store{Pool: pool}), h.auth, logger).RegisterRoutes(mux)
	h.handler = RequestLogging(logger, mux)
	armed.Store(true)
	body := `{"version":null,"role":"admin","expectedUserId":"` + h.adminID + `"}`
	response := h.call("PUT", "/api/v1/projects/"+h.project.ID+"/grants/"+h.memberID, body, h.admin)
	if !lost.Load() || response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"write_outcome_unknown"`) {
		t.Fatalf("lost=%v status=%d body=%s", lost.Load(), response.Code, response.Body)
	}
	var role string
	var version int64
	if err := h.database.Pool.QueryRow(ctx, `SELECT role,version FROM project_grants WHERE project_id=$1 AND user_id=$2`, h.project.ID, h.memberID).Scan(&role, &version); err != nil || role != "admin" || version <= 0 {
		t.Fatalf("current committed grant: role=%s version=%d err=%v", role, version, err)
	}
}
