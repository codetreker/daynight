package secret

import (
	"bytes"
	"runtime"
	"strings"
	"testing"
)

func TestSecretFormatAndHash(t *testing.T) {
	a, b := Random("dnpat_"), Random("dnpat_")
	if a == b || !Valid(a, "dnpat_") || Valid(a, "dnst_") || Valid(a+"=", "dnpat_") || Valid("dnpat_short", "dnpat_") {
		t.Fatal("invalid secret generation or validation")
	}
	if len(Hash(a)) != 32 || !bytes.Equal(Hash(a), Hash(a)) || bytes.Equal(Hash(a), Hash(b)) {
		t.Fatal("invalid secret hash")
	}
}

func TestSecretEncodedLengthBeforeDecode(t *testing.T) {
	for _, prefix := range []string{"", "dnpat_", "dnst_"} {
		value := Random(prefix)
		if !Valid(value, prefix) || Valid(value+"A", prefix) || Valid(value[:len(value)-1], prefix) {
			t.Fatalf("incorrect length handling for %q", prefix)
		}
	}
	oversized := "dnpat_" + strings.Repeat("A", 1<<20)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_ = Valid(oversized, "dnpat_")
	runtime.ReadMemStats(&after)
	if used := after.TotalAlloc - before.TotalAlloc; used > 64<<10 {
		t.Fatalf("oversized secret allocated %d bytes", used)
	}
}
