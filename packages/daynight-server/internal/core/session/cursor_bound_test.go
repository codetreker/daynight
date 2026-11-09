package session

import (
	"errors"
	"runtime"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestSessionCursorBoundsBeforeDecode(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		parse      func(string) error
	}{
		{"event", "reset_required", func(s string) error { _, err := decodeCursor(s, sp.Snapshot{}, "event"); return err }},
		{"test list", "invalid_input", func(s string) error { _, err := testListCursor(s, "owner", false); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			oversized := strings.Repeat("A", 1<<20)
			var f *model.Fault
			if err := tc.parse(oversized); !errors.As(err, &f) || f.Code != tc.code {
				t.Fatalf("fault = %v", err)
			}
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			_ = tc.parse(oversized)
			runtime.ReadMemStats(&after)
			if used := after.TotalAlloc - before.TotalAlloc; used > 64<<10 {
				t.Fatalf("oversized cursor allocated %d bytes", used)
			}
		})
	}
}
