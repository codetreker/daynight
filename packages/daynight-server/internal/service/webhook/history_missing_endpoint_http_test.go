package webhook_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestHistoryHTTPRetainedDeliveryWithoutEndpoint(t *testing.T) {
	r := newRetentionHTTP(t, false)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET state='pending',automatic_open=true,next_attempt_at=now(),terminal_at=NULL WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM webhook_endpoints WHERE id=$1`, r.endpoint); err != nil {
		t.Fatal(err)
	}
	call := func(path string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(r.f.ctx, http.MethodGet, r.host.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: r.token})
		resp, err := r.host.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Header.Get("Daynight-User-ID") != r.f.principal.UserID || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal(resp.Header)
		}
		return resp.StatusCode, body
	}
	base := "/api/v1/me/webhooks/" + r.endpoint + "/deliveries"
	status, body := call(base + "/" + r.delivery)
	if status != 200 {
		t.Fatalf("delivery status=%d body=%s", status, body)
	}
	var delivery struct {
		State, Disclosure string
		PayloadAvailable  bool
	}
	if err := json.Unmarshal(body, &delivery); err != nil || delivery.State != "suppressed" || delivery.Disclosure != "full" || !delivery.PayloadAvailable {
		t.Fatalf("delivery=%+v body=%s err=%v", delivery, body, err)
	}
	status, body = call(base)
	if status != 200 {
		t.Fatalf("history status=%d body=%s", status, body)
	}
	var page struct{ Items []struct{ ID, State string } }
	if err := json.Unmarshal(body, &page); err != nil || len(page.Items) != 1 || page.Items[0].ID != r.delivery || page.Items[0].State != "suppressed" {
		t.Fatalf("page=%+v body=%s err=%v", page, body, err)
	}
	for _, suffix := range []string{"/payload", "/attempts"} {
		if status, body = call(base + "/" + r.delivery + suffix); status != 200 {
			t.Fatalf("%s status=%d body=%s", suffix, status, body)
		}
	}
	status, body = call("/api/v1/me/webhooks/" + uuid.NewString() + "/deliveries")
	if status != 404 {
		t.Fatalf("absent endpoint and history status=%d body=%s", status, body)
	}
	status, body = call("/api/v1/teams/" + uuid.NewString() + "/webhooks/" + r.endpoint + "/deliveries/" + r.delivery)
	if status != 403 {
		t.Fatalf("other owner status=%d body=%s", status, body)
	}
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET state='failed',next_attempt_at=NULL,automatic_open=false,terminal_at=now()-interval '31 days',last_activity_at=now()-interval '31 days',metadata_expires_at=now()-interval '1 day' WHERE id=$1`, r.delivery); err != nil {
		t.Fatal(err)
	}
	status, body = call(base + "/" + r.delivery)
	if status != 404 || !strings.Contains(string(body), `"code":"not_found"`) {
		t.Fatalf("expired status=%d body=%s", status, body)
	}
}
