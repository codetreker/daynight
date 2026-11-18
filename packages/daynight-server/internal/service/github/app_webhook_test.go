package github

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

func TestAppWebhookLogsCorrelation(t *testing.T) {
	var output bytes.Buffer
	s := &appWebhookStore{outcome: store.TransactionCommitted}
	r, err := NewAppWebhookReceiver(s, slog.New(slog.NewJSONHandler(&output, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx := requestid.With(context.Background(), "request-1")
	identity := AppWebhookIdentity{AppID: "app-1", CredentialVersion: 7}
	err = r.ReceiveAppWebhook(ctx, identity, core.WebhookEvent{Kind: "access", DeliveryID: "delivery-1", InstallationID: 2})
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["request_id"] != "request-1" || entry["delivery_id"] != "delivery-1" || entry["app_resource_id"] != "app-1" || entry["component"] != "github_webhook" || entry["phase"] != "receive" || entry["write_outcome"] != "committed" {
		t.Fatalf("correlation log: %+v", entry)
	}
}

type appWebhookStore struct {
	snapshot store.GitHubAppWebhookSnapshot
	readErr  error
	outcome  store.TransactionOutcome
	writeErr error
	app      string
	version  int64
	writes   int
	access   *store.GitHubAppAccessSignal
}

func (s *appWebhookStore) ReadGitHubAppWebhook(_ context.Context, app string) (store.GitHubAppWebhookSnapshot, error) {
	s.app = app
	return s.snapshot, s.readErr
}
func (s *appWebhookStore) WriteGitHubAppSignals(_ context.Context, app string, version int64, f func(store.GitHubAppSignalWriter) error) (store.Completion, error) {
	s.writes++
	s.app = app
	s.version = version
	if s.writeErr != nil {
		return store.Completion{Outcome: s.outcome}, s.writeErr
	}
	return store.Completion{Outcome: s.outcome}, f(s)
}
func (s *appWebhookStore) SignalAccess(_ context.Context, p store.GitHubAppAccessSignal) (int64, error) {
	s.access = &p
	return 1, nil
}

func TestAppWebhookAuthenticationAndCommit(t *testing.T) {
	if _, err := NewAppWebhookReceiver(nil, nil); err == nil {
		t.Fatal("accepted nil store")
	}
	s := &appWebhookStore{snapshot: store.GitHubAppWebhookSnapshot{CredentialVersion: 7, Secret: []byte("secret")}, outcome: store.TransactionCommitted}
	r, err := NewAppWebhookReceiver(s, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"number":4}`)
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	id, err := r.AuthenticateAppWebhook(context.Background(), "local", body, signature)
	if err != nil || id != (AppWebhookIdentity{AppID: "local", CredentialVersion: 7}) {
		t.Fatalf("identity %+v: %v", id, err)
	}
	for _, bad := range []string{"", "sha256=xyz", "sha256=" + hex.EncodeToString(make([]byte, 32)), "SHA256=" + signature[7:]} {
		if _, err := r.AuthenticateAppWebhook(context.Background(), "local", body, bad); !errors.Is(err, ErrAppWebhookUnauthenticated) {
			t.Fatalf("accepted signature %q: %v", bad, err)
		}
	}
	if _, err := r.AuthenticateAppWebhook(context.Background(), "local", append(body, ' '), signature); !errors.Is(err, ErrAppWebhookUnauthenticated) {
		t.Fatal("accepted altered body")
	}
	cause := errors.New("read failure")
	s.readErr = cause
	if _, err := r.AuthenticateAppWebhook(context.Background(), "local", body, signature); !errors.Is(err, cause) {
		t.Fatalf("read: %v", err)
	}
	s.readErr = nil
	event := core.WebhookEvent{Kind: "access", DeliveryID: "delivery", InstallationID: 3}
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionNotCommitted, store.TransactionUnknown} {
		s.outcome = outcome
		s.writes = 0
		s.access = nil
		err := r.ReceiveAppWebhook(context.Background(), id, event)
		if (err == nil) != (outcome == store.TransactionCommitted) || s.writes != 1 || s.app != "local" || s.version != 7 || s.access == nil || s.access.InstallationID != 3 || s.access.DeliveryID != "delivery" {
			t.Fatalf("outcome %s: %+v %v", outcome, s, err)
		}
		if outcome == store.TransactionUnknown && !errors.Is(err, errUnknown) {
			t.Fatalf("lost unknown: %v", err)
		}
	}
	s.outcome = store.TransactionNotCommitted
	s.writeErr = store.ErrGitHubAppWebhookChanged
	s.writes = 0
	s.access = nil
	if err := r.ReceiveAppWebhook(context.Background(), id, event); !errors.Is(err, store.ErrGitHubAppWebhookChanged) || s.writes != 1 || s.access != nil {
		t.Fatalf("changed snapshot: %v", err)
	}
	s.writeErr = nil
	s.outcome = store.TransactionCommitted
	event.Kind = "access"
	s.access = nil
	if err := r.ReceiveAppWebhook(context.Background(), id, event); err != nil || s.access == nil {
		t.Fatalf("access: %v", err)
	}
}
