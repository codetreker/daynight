package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The connection consumes PostgreSQL's successful COMMIT CommandComplete before
// losing its reply. The underlying write is durable even though pgx cannot
// establish its result from the interrupted exchange.
type lostWebhookCommitConn struct {
	net.Conn
	armed   *atomic.Bool
	lost    *atomic.Bool
	pending bool
	buffer  []byte
}

func (c *lostWebhookCommitConn) Write(data []byte) (int, error) {
	if c.armed.Load() && bytes.Contains(bytes.ToLower(data), []byte("commit\x00")) {
		c.pending = true
	}
	return c.Conn.Write(data)
}

func (c *lostWebhookCommitConn) Read(out []byte) (int, error) {
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

type commitLossPersistence struct {
	*postgres.Store
	armed *atomic.Bool
}

// Snapshot prechecks also commit. Arming at the write entry keeps their replies
// intact and targets only the transaction that can persist the requested effect.
func (d commitLossPersistence) WriteWebhook(ctx context.Context, owner webhookmodel.Owner, id string, callback func(store.WebhookWriteScope) error) (store.Completion, error) {
	d.armed.Store(true)
	return d.Store.WriteWebhook(ctx, owner, id, callback)
}

func TestWebhookHTTPCommitReplyLossPreservesReceiptAndSingleEffect(t *testing.T) {
	h := newIntegrationHarness(t)
	ctx := context.Background()
	var armed, lost atomic.Bool
	config := h.Database.Pool.Config().Copy()
	config.ConnConfig.TLSConfig, config.ConnConfig.Fallbacks = nil, nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostWebhookCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h.mount(t, commitLossPersistence{Store: &postgres.Store{Pool: pool}, armed: &armed}, h.keyring, true)
	const base = "/api/v1/me/webhooks"
	input := createBody(h, h.alice)
	requestBody := body(t, input)
	response := h.call(http.MethodPost, base, requestBody, h.aliceCookie)
	if !lost.Load() {
		t.Fatal("the writable transaction's successful COMMIT reply was not lost")
	}
	errorStatus(t, response, http.StatusServiceUnavailable, "write_outcome_unknown")
	if strings.Contains(response.Body.String(), "sensitive") || strings.Contains(response.Body.String(), "whsec_") {
		t.Fatal("unknown write response disclosed destination or signing material")
	}
	operationID := input["operationId"].(string)
	endpointID, requestHash := persistedWebhookOperation(t, h, operationID)
	hash := sha256.Sum256([]byte(requestBody))
	if requestHash != hex.EncodeToString(hash[:]) {
		t.Fatal("committed receipt does not bind the submitted request bytes")
	}
	h.mount(t, h.Database, h.keyring, true)
	receipt := decoded[operationResponse](t, h.call(http.MethodGet, base+"/operations/"+operationID, "", h.aliceCookie), http.StatusOK)
	if receipt.EndpointID != endpointID || receipt.RequestSHA256 != requestHash || receipt.ConfigVersionAfter != "1" {
		t.Fatal("GET did not recover the exact originally committed operation")
	}
	replayed := decoded[mutationResponse](t, h.call(http.MethodPost, base, requestBody, h.aliceCookie), http.StatusOK)
	if decodeEndpoint(t, replayed.Endpoint).ID != endpointID || replayed.Operation.OperationID != operationID {
		t.Fatal("replay produced a replacement endpoint or operation")
	}
	assertOneWebhookEffect(t, h, operationID, endpointID)
	assertWebhookDiagnosticsPrivate(t, h, endpointID)
}

type failedWebhookResponseWriter struct {
	*httptest.ResponseRecorder
	writes int
}

func (w *failedWebhookResponseWriter) Write([]byte) (int, error) {
	w.writes++
	return 0, io.ErrClosedPipe
}

func TestWebhookCommittedHTTPResponseLossLeavesQueryableOriginalOperation(t *testing.T) {
	h := newIntegrationHarness(t)
	const base = "/api/v1/me/webhooks"
	input := createBody(h, h.alice)
	requestBody := body(t, input)
	request := httptest.NewRequest(http.MethodPost, base, strings.NewReader(requestBody))
	request.AddCookie(h.aliceCookie)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", h.Origin)
	request.Header.Set("X-Request-ID", "webhook-response-loss")
	writer := &failedWebhookResponseWriter{ResponseRecorder: httptest.NewRecorder()}
	h.Handler.ServeHTTP(writer, request)
	if writer.writes != 1 || writer.Code != http.StatusCreated || writer.Body.Len() != 0 {
		t.Fatal("the committed success response did not reach the failing writer exactly once")
	}
	if !strings.Contains(h.Logs.String(), `"webhook_error_code":"write_outcome_unknown"`) || !strings.Contains(h.Logs.String(), `"request_id":"webhook-response-loss"`) {
		t.Fatal("HTTP delivery failure lacks the original request's unknown-result diagnostic")
	}
	operationID := input["operationId"].(string)
	endpointID, requestHash := persistedWebhookOperation(t, h, operationID)
	hash := sha256.Sum256([]byte(requestBody))
	if requestHash != hex.EncodeToString(hash[:]) {
		t.Fatal("lost HTTP response did not retain the original body hash")
	}
	receipt := decoded[operationResponse](t, h.call(http.MethodGet, base+"/operations/"+operationID, "", h.aliceCookie), http.StatusOK)
	if receipt.EndpointID != endpointID || receipt.RequestSHA256 != requestHash {
		t.Fatal("lost HTTP response prevented original operation recovery")
	}
	replayed := decoded[mutationResponse](t, h.call(http.MethodPost, base, requestBody, h.aliceCookie), http.StatusOK)
	if decodeEndpoint(t, replayed.Endpoint).ID != endpointID {
		t.Fatal("lost HTTP response replay created another endpoint")
	}
	assertOneWebhookEffect(t, h, operationID, endpointID)
	assertWebhookDiagnosticsPrivate(t, h, endpointID)
}

func persistedWebhookOperation(t *testing.T, h *integrationHarness, operationID string) (string, string) {
	t.Helper()
	var endpointID, requestHash string
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT endpoint_id::text,request_sha256 FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$1 AND operation_id=$2`, h.alice.UserID, operationID).Scan(&endpointID, &requestHash); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT config_version FROM webhook_endpoints WHERE id=$1 AND owner_kind='personal' AND owner_id=$2`, endpointID, h.alice.UserID).Scan(&version); err != nil || version != 1 {
		t.Fatalf("original committed endpoint is missing or modified: version=%d err=%v", version, err)
	}
	return endpointID, requestHash
}

func assertOneWebhookEffect(t *testing.T, h *integrationHarness, operationID, endpointID string) {
	t.Helper()
	var endpoints, operations int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_endpoints WHERE owner_kind='personal' AND owner_id=$1`, h.alice.UserID).Scan(&endpoints); err != nil {
		t.Fatal(err)
	}
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$1`, h.alice.UserID).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if endpoints != 1 || operations != 1 {
		t.Fatalf("operation replay duplicated its durable effect: endpoints=%d operations=%d", endpoints, operations)
	}
	actualEndpoint, _ := persistedWebhookOperation(t, h, operationID)
	if actualEndpoint != endpointID {
		t.Fatal("original operation changed its endpoint identity")
	}
}

func assertWebhookDiagnosticsPrivate(t *testing.T, h *integrationHarness, endpointID string) {
	t.Helper()
	secret := decoded[secretResponse](t, h.call(http.MethodGet, "/api/v1/me/webhooks/"+endpointID+"/signing-secret", "", h.aliceCookie), http.StatusOK)
	if strings.Contains(h.Logs.String(), "sensitive") || strings.Contains(h.Logs.String(), secret.Secret) {
		t.Fatal("unknown-result diagnostics disclosed destination credentials or signing material")
	}
}
