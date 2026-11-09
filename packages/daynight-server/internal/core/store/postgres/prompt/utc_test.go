package prompt

import (
	"testing"
	"time"
)

func TestPromptUTCMapping(t *testing.T) {
	if promptUTC(nil) != nil {
		t.Fatal("missing timestamp became present")
	}
	source := time.Date(2026, 1, 1, 12, 30, 0, 0, time.FixedZone("offset", 2*60*60))
	got := promptUTC(&source)
	if got == nil || got.Location() != time.UTC || !got.Equal(source) || source.Location() == time.UTC {
		t.Fatalf("UTC conversion: %v, source %v", got, source)
	}
}
