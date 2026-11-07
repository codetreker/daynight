package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The proxy forwards the write and drops only the real PostgreSQL COMMIT
// CommandComplete frame from the operation-fenced transaction.
type redeliveryLostCommit struct {
	net.Conn
	fenced, pending bool
	lost            *atomic.Bool
	buffered        []byte
}

func (c *redeliveryLostCommit) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("pg_advisory_xact_lock")) {
		c.fenced = true
	}
	if c.fenced && bytes.Contains(bytes.ToLower(p), []byte("commit\x00")) {
		c.pending = true
	}
	return c.Conn.Write(p)
}
func (c *redeliveryLostCommit) Read(p []byte) (int, error) {
	if len(c.buffered) > 0 {
		n := copy(p, c.buffered)
		c.buffered = c.buffered[n:]
		return n, nil
	}
	if !c.pending {
		return c.Conn.Read(p)
	}
	var header [5]byte
	if _, err := io.ReadFull(c.Conn, header[:]); err != nil {
		return 0, err
	}
	n := int(binary.BigEndian.Uint32(header[1:]))
	if n < 4 || n > 1024*1024 {
		return 0, errors.New("invalid PostgreSQL frame")
	}
	payload := make([]byte, n-4)
	if _, err := io.ReadFull(c.Conn, payload); err != nil {
		return 0, err
	}
	if header[0] == 'C' && bytes.Equal(payload, []byte("COMMIT\x00")) {
		c.lost.Store(true)
		_ = c.Conn.Close()
		return 0, io.EOF
	}
	c.buffered = append(header[:], payload...)
	n = copy(p, c.buffered)
	c.buffered = c.buffered[n:]
	return n, nil
}

func TestRedeliveryHTTPCommitReplyLostAfterCommandComplete(t *testing.T) {
	r := newRetentionHTTP(t, false)
	var beforeTicket int64
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT queue_order FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&beforeTicket); err != nil {
		t.Fatal(err)
	}
	var lost atomic.Bool
	cfg := r.f.db.Pool.Config().Copy()
	cfg.MaxConns = 1
	cfg.ConnConfig.TLSConfig = nil
	cfg.ConnConfig.Fallbacks = nil
	cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &redeliveryLostCommit{Conn: c, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(r.f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(r.f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(&webhook.Service{DB: &postgres.Store{Pool: pool}, Keys: r.f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}, auth, logger).RegisterRoutes(mux)
	faultHost := httptest.NewServer(mux)
	defer faultHost.Close()
	operation := uuid.NewString()
	issued := time.Now().UTC().Format(time.RFC3339Nano)
	body := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"1","ifGeneration":"1"}`, operation, issued, r.f.principal.UserID)
	base := "/api/v1/me/webhooks/" + r.endpoint + "/deliveries/" + r.delivery
	call := func(host *httptest.Server, method, path, body string) (int, []byte) {
		t.Helper()
		req, e := http.NewRequestWithContext(r.f.ctx, method, host.URL+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: r.token})
		req.Header.Set("Origin", "https://daynight.example")
		req.Header.Set("Content-Type", "application/json")
		resp, e := host.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.Header.Get("Daynight-User-ID") != r.f.principal.UserID || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal(resp.Header)
		}
		return resp.StatusCode, data
	}
	status, response := call(faultHost, "POST", base+"/redeliveries", body)
	if !lost.Load() || status != 503 || !bytes.Contains(response, []byte(`"code":"write_outcome_unknown"`)) {
		t.Fatalf("lost=%t status=%d body=%s", lost.Load(), status, response)
	}
	hash := sha256.Sum256([]byte(body))
	expectedHash := hex.EncodeToString(hash[:])
	type observation struct {
		generation, ticket                   int64
		manual, sequence, attempts, receipts int
		hash, state, trigger                 string
	}
	observe := func() observation {
		t.Helper()
		var x observation
		err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT d.generation,d.queue_order,d.manual_operation_count,d.attempt_sequence,d.state,d.trigger,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT count(*) FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$2 AND operation_id=$3),COALESCE((SELECT encode(request_sha256,'hex') FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$2 AND operation_id=$3),'') FROM webhook_deliveries d WHERE d.id=$1`, r.delivery, r.f.principal.UserID, operation).Scan(&x.generation, &x.ticket, &x.manual, &x.sequence, &x.state, &x.trigger, &x.attempts, &x.receipts, &x.hash)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	first := observe()
	if first.generation != 2 || first.ticket <= beforeTicket || first.manual != 1 || first.sequence != 0 || first.attempts != 0 || first.receipts != 1 || first.hash != expectedHash || first.state != "pending" || first.trigger != "manual" {
		t.Fatalf("committed effect: %+v", first)
	}
	status, response = call(r.host, "GET", "/api/v1/me/webhooks/operations/"+operation, "")
	var receipt struct{ OperationID, IssuedAt, RequestSHA256, DeliveryID, GenerationAfter string }
	if status != 200 || json.Unmarshal(response, &receipt) != nil || receipt.OperationID != operation || receipt.IssuedAt != issued || receipt.RequestSHA256 != expectedHash || receipt.DeliveryID != r.delivery || receipt.GenerationAfter != "2" {
		t.Fatalf("receipt status=%d body=%s decoded=%+v", status, response, receipt)
	}
	status, response = call(r.host, "POST", base+"/redeliveries", body)
	if status != 202 {
		t.Fatalf("replay status=%d body=%s", status, response)
	}
	if after := observe(); after != first {
		t.Fatalf("replay changed persisted effect: before=%+v after=%+v", first, after)
	}
}
