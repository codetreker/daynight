package requestid

import (
	"context"
	"testing"
)

func TestRequestIDContext(t *testing.T) {
	parent := context.Background()
	if got := From(parent); got != "" {
		t.Fatalf("unset request ID = %q", got)
	}
	first := With(parent, "first")
	second := With(first, "second")
	if got := From(first); got != "first" {
		t.Fatalf("parent request ID = %q", got)
	}
	if got := From(second); got != "second" {
		t.Fatalf("child request ID = %q", got)
	}
	if got := From(parent); got != "" {
		t.Fatalf("root request ID changed to %q", got)
	}
}
