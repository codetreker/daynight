package attachment

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestContentAdmission(t *testing.T) {
	if err := AdmitContentSize(MaxContentBytes); err != nil {
		t.Fatal(err)
	}
	if err := AdmitContentSize(0); err != nil {
		t.Fatal(err)
	}
	var v *limit.Violation
	if err := AdmitContentSize(-1); !errors.As(err, &v) || v.Actual != -1 || v.Max != MaxContentBytes || v.Min == nil || *v.Min != 0 || v.Unit != "bytes" {
		t.Fatalf("unexpected lower bound: %v", err)
	}
	v = nil
	if err := AdmitContentSize(MaxContentBytes + 1); !errors.As(err, &v) || v.Actual != MaxContentBytes+1 || v.Max != MaxContentBytes {
		t.Fatalf("unexpected result: %v", err)
	}
}
