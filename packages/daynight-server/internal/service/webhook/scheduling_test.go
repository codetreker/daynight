package webhook

import (
	"testing"
	"time"
)

func TestBackgroundSchedulingDefaults(t *testing.T) {
	if got := NewRunner(nil, nil, false).pollInterval; got != time.Second {
		t.Fatalf("delivery poll interval = %v, want 1s", got)
	}
	retention := NewRetention(nil)
	if retention.retryInterval != time.Second || retention.passTimeout != 2*time.Second {
		t.Fatalf("retention retry=%v pass=%v, want 1s/2s", retention.retryInterval, retention.passTimeout)
	}
}
