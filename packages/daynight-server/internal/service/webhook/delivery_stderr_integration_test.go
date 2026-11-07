package webhook_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// A child with a real PG-backed sender and TLS receiver writes JSON to stderr;
// the parent verifies the actual stream rather than inspecting logger calls.
func TestDeliveryStderrLogIncludesObservedValues(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDeliveryRealCaptureTLSAndSignature$", "-test.count=1")
	cmd.Env = append(os.Environ(), "DAYNIGHT_T07_LOG_STDERR=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("sender child: %v stdout=%s stderr=%s", err, stdout.String(), stderr.String())
	}
	for _, forbidden := range []string{"delivery source", "127.0.0.1", "Webhook-Signature", "whsec_"} {
		if strings.Contains(stderr.String(), forbidden) {
			t.Fatalf("sensitive content %q in stderr", forbidden)
		}
	}
	seen := map[string]bool{}
	var event string
	var observedDuration float64
	scanner := bufio.NewScanner(bytes.NewReader(stderr.Bytes()))
	for scanner.Scan() {
		var entry map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("invalid JSON stderr: %v", err)
		}
		if entry["component"] != "webhook" {
			continue
		}
		phase, _ := entry["phase"].(string)
		id, _ := entry["event_id"].(string)
		if id == "" {
			t.Fatalf("missing event ID: %v", entry)
		}
		if event == "" {
			event = id
		} else if event != id {
			t.Fatal("sender phases did not correlate")
		}
		if entry["adapter"] != "http" || entry["adapter_version"] != float64(1) {
			t.Fatalf("adapter fields: %v", entry)
		}
		if value, ok := entry["operation_id"]; !ok || value != nil {
			t.Fatalf("automatic delivery must have null operation: %v", entry)
		}
		switch phase {
		case "claim", "admitted", "http":
			if entry["http_status"] != nil || entry["duration_ms"] != nil || entry["outcome"] != nil {
				t.Fatalf("unobserved values: %v", entry)
			}
		case "finalize", "finished":
			duration, ok := entry["duration_ms"].(float64)
			if !ok || duration < 0 || entry["http_status"] != float64(202) || entry["outcome"] != "acknowledged" {
				t.Fatalf("observed values: %v", entry)
			}
			observedDuration = duration
		default:
			continue
		}
		seen[phase] = true
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"claim", "admitted", "http", "finalize", "finished"} {
		if !seen[phase] {
			t.Fatalf("missing phase %s in %s", phase, stderr.String())
		}
	}
	t.Logf("event=%s phases=claim,admitted,http,finalize,finished status=202 outcome=acknowledged duration_ms=%v", event, observedDuration)
}
