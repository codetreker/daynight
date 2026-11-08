package bot

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestAdmitCwd(t *testing.T) {
	cwd := "/" + strings.Repeat("é", (MaxCwdBytes-2)/2) + "x"
	if len(cwd) != MaxCwdBytes || !botAbsolutePath(cwd) {
		t.Fatal("invalid fixture")
	}
	if err := AdmitCwd(cwd); err != nil {
		t.Fatal(err)
	}
	var v *limit.Violation
	if err := AdmitCwd(cwd + "x"); !errors.As(err, &v) || v.Field != "cwd" || v.Actual != MaxCwdBytes+1 || v.Max != MaxCwdBytes || v.Unit != "bytes" {
		t.Fatalf("violation: %v", err)
	}
}
