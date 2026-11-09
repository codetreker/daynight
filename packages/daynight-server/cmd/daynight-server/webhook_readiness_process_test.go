//go:build startupshutdown

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// A real process and its production readiness route must observe an owned
// worker failure even while the database remains reachable.
func TestWebhookProcessReadinessTracksWorkerFailure(t *testing.T) {
	values := processAPIEnvironment(t)
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "0"
	parsed, err := url.Parse(values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	application := "webhook_failure_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	query := parsed.Query()
	query.Set("application_name", application)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	child := startPersistenceProcess(t, values)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := pgx.Connect(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(context.Background())
	if _, err = db.Exec(ctx, `DROP TABLE webhook_deliveries`); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		resp, e := client.Get(values["DAYNIGHT_PUBLIC_ORIGIN"] + "/readyz")
		if e == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusServiceUnavailable {
				break
			}
		}
		select {
		case <-ctx.Done():
			t.Fatalf("worker failure not reflected in HTTP readiness: %s", child.logs.String())
		case <-ticker.C:
		}
	}
	var one int
	if err = db.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
		t.Fatalf("database unavailable after worker failure: %d %v", one, err)
	}
	var logs string
	for {
		logs = child.logs.String()
		if strings.Contains(logs, `"msg":"webhook runtime failed"`) {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("worker failure was not logged: %s", logs)
		case <-ticker.C:
		}
	}
	for _, line := range strings.Split(logs, "\n") {
		var entry struct {
			Message   string `json:"msg"`
			Component string `json:"component"`
			Operation string `json:"operation"`
		}
		if json.Unmarshal([]byte(line), &entry) == nil && entry.Message == "webhook runtime failed" && (entry.Component != "webhook" || entry.Operation != "maintain") {
			t.Fatalf("unexpected worker failure diagnostic: %s", line)
		}
	}
	for _, private := range []string{values["DAYNIGHT_DATABASE_URL"], values["DAYNIGHT_UNIAUTH_APP_SECRET"], "webhook_deliveries"} {
		if private != "" && strings.Contains(logs, private) {
			t.Fatal("worker failure diagnostic exposed private configuration or SQL")
		}
	}
	if err = child.stop(); err != nil {
		t.Fatalf("shutdown after worker failure: %v", err)
	}
	t.Log("production /readyz=503 after permanent worker failure while PostgreSQL SELECT 1=1")
}
