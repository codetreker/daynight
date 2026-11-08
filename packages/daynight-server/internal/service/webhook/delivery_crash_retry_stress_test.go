//go:build stress

package webhook_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

// The original capture occurs 50 seconds in the past through a controlled
// source-row timestamp, so its unmodified second opportunity is near. This
// slower real-time retry runs separately from the routine CI suite.
func TestDeliveryCrashUsesNewAttemptStress(t *testing.T) {
	requests := make(chan []byte, 2)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		requests <- b
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION test_historical_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at=statement_timestamp()-interval '50 seconds'; NEW.updated_at=NEW.created_at; RETURN NEW; END $$; CREATE TRIGGER test_historical_source BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION test_historical_source()`); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "original budget"}); err != nil {
		t.Fatal(err)
	}
	var id string
	var original []byte
	var schedule []time.Time
	var expires time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,body,automatic_schedule_at,automatic_expires_at FROM webhook_deliveries`).Scan(&id, &original, &schedule, &expires); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(f.ctx, os.Args[0], "-test.run=^TestDeliveryProcessExitRecovery$", "-test.count=1")
	cmd.Env = append(os.Environ(), "DAYNIGHT_T04_EXIT_MODE=admitted", "DAYNIGHT_T04_EXIT_DB="+f.db.Pool.Config().ConnString(), "DAYNIGHT_T04_EXIT_CERT="+base64.StdEncoding.EncodeToString(receiver.Certificate().Raw))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v %s", err, out)
	}
	var oldID, oldToken string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,lease_token::text FROM webhook_attempts WHERE delivery_id=$1`, id).Scan(&oldID, &oldToken); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	}()
	select {
	case body := <-requests:
		if !bytes.Equal(body, original) {
			t.Fatal("retry changed original bytes")
		}
	case err := <-runner.Failures():
		t.Fatalf("runner: %v", err)
	case <-time.After(22 * time.Second):
		t.Fatal("original next opportunity did not dispatch")
	}
	deadline := time.After(5 * time.Second)
	for {
		var state string
		var count int
		var actualSchedule []time.Time
		var actualExpires time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,automatic_attempt_count,automatic_schedule_at,automatic_expires_at FROM webhook_deliveries WHERE id=$1`, id).Scan(&state, &count, &actualSchedule, &actualExpires); err != nil {
			t.Fatal(err)
		}
		if state == "delivered" {
			if count != 2 || !actualExpires.Equal(expires) || len(actualSchedule) != len(schedule) {
				t.Fatalf("budget changed count=%d", count)
			}
			for i := range schedule {
				if !schedule[i].Equal(actualSchedule[i]) {
					t.Fatal("original schedule changed")
				}
			}
			var newID, newToken, oldOutcome, newOutcome string
			var recovered *time.Time
			err := f.db.Pool.QueryRow(f.ctx, `SELECT a.outcome,a.recovered_unknown_at,b.id::text,b.lease_token::text,b.outcome FROM webhook_attempts a JOIN webhook_attempts b ON b.delivery_id=a.delivery_id AND b.sequence=2 WHERE a.id=$1`, oldID).Scan(&oldOutcome, &recovered, &newID, &newToken, &newOutcome)
			if err != nil || oldOutcome != "unknown" || recovered == nil || newOutcome != "acknowledged" || newID == oldID || newToken == oldToken {
				t.Fatalf("old/new attempt: %v %s %s", err, oldOutcome, newOutcome)
			}
			return
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner: %v", err)
		case <-deadline:
			t.Fatal("retry outcome not persisted")
		case <-time.After(20 * time.Millisecond):
		}
	}
}
