package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	httpwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identity "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

type lostWebhookCommit struct {
	net.Conn
	fenced, pending bool
	lost            *atomic.Bool
	buffer          []byte
}

func (c *lostWebhookCommit) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte("pg_advisory_xact_lock")) {
		c.fenced = true
	}
	if c.fenced && bytes.Contains(bytes.ToLower(data), []byte("commit\x00")) {
		c.pending = true
	}
	return c.Conn.Write(data)
}
func (c *lostWebhookCommit) Read(out []byte) (int, error) {
	if len(c.buffer) > 0 {
		n := copy(out, c.buffer)
		c.buffer = c.buffer[n:]
		return n, nil
	}
	if !c.pending {
		return c.Conn.Read(out)
	}
	var hdr [5]byte
	if _, err := io.ReadFull(c.Conn, hdr[:]); err != nil {
		return 0, err
	}
	n := int(binary.BigEndian.Uint32(hdr[1:]))
	if n < 4 || n > 1024*1024 {
		return 0, errors.New("invalid PostgreSQL frame")
	}
	payload := make([]byte, n-4)
	if _, err := io.ReadFull(c.Conn, payload); err != nil {
		return 0, err
	}
	if hdr[0] == 'C' && bytes.Equal(payload, []byte("COMMIT\x00")) {
		c.lost.Store(true)
		_ = c.Conn.Close()
		return 0, io.EOF
	}
	c.buffer = append(hdr[:], payload...)
	n = copy(out, c.buffer)
	c.buffer = c.buffer[n:]
	return n, nil
}

func TestWebhookHTTPCommitReplyLostAfterCommandComplete(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	master := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"main","keys":{"main":"` + master + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	var lost atomic.Bool
	cfg := f.db.Pool.Config().Copy()
	cfg.ConnConfig.TLSConfig = nil
	cfg.ConnConfig.Fallbacks = nil
	cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostWebhookCommit{Conn: conn, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	identityService := identity.New(f.db, nil, testOrigin+"/auth/callback")
	authenticator, err := auth.NewAuthentication(identityService, config.AuthSettings{PublicOrigin: testOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	httpwebhook.RegisterRoutes(mux, httpwebhook.Adapter{Service: &service.Service{DB: &postgres.Store{Pool: pool}, Keys: keys}}, authenticator, logger)
	faultServer := httptest.NewServer(mux)
	defer faultServer.Close()
	normalServer := f.server
	f.server = faultServer
	fields := createFields(actor, "endpoint", "https://example.test/private")
	body := encoded(t, fields)
	op := fields["operationId"].(string)
	status, _, response := f.request(t, actor, "POST", "/api/v1/me/webhooks", body)
	f.server = normalServer
	if !lost.Load() || status != 503 || !strings.Contains(string(response), `"code":"write_outcome_unknown"`) {
		t.Fatalf("lost=%v status=%d body=%s", lost.Load(), status, response)
	}
	var endpoints, receipts int
	var actualHash, target string
	err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1),request_sha256,target_id::text FROM webhook_operations WHERE owner_id=$1 AND operation_id=$2`, actor.id, op).Scan(&endpoints, &receipts, &actualHash, &target)
	sum := sha256.Sum256([]byte(body))
	if err != nil || endpoints != 1 || receipts != 1 || actualHash != hex.EncodeToString(sum[:]) {
		t.Fatalf("effect endpoints=%d receipts=%d hash=%s err=%v", endpoints, receipts, actualHash, err)
	}
	status, _, lookup := f.request(t, actor, "GET", "/api/v1/me/webhooks/operations/"+op, "")
	if status != 200 || !strings.Contains(string(lookup), actualHash) {
		t.Fatalf("lookup %d %s", status, lookup)
	}
	status, _, replay := f.request(t, actor, "POST", "/api/v1/me/webhooks", body)
	if status != 200 {
		t.Fatalf("replay %d %s", status, replay)
	}
	var decoded struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err := json.Unmarshal(replay, &decoded); err != nil || decoded.Endpoint.ID != target {
		t.Fatalf("replay endpoint=%s target=%s err=%v", decoded.Endpoint.ID, target, err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1`, actor.id).Scan(&endpoints); err != nil || endpoints != 1 {
		t.Fatalf("duplicate effect %d %v", endpoints, err)
	}
}
