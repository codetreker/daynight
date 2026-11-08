package project

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestAdmission(t *testing.T) {
	if err := AdmitName(strings.Repeat("é", 256)); err != nil {
		t.Fatal(err)
	}
	if err := AdmitName(strings.Repeat("é", 257)); err == nil {
		t.Fatal("name accepted")
	}
	if err := AdmitRepoURL(strings.Repeat("é", 2048)); err != nil {
		t.Fatal(err)
	}
	var v *limit.Violation
	if err := AdmitRepoURL(strings.Repeat("a", MaxRepoURLBytes+1)); !errors.As(err, &v) || v.Actual != MaxRepoURLBytes+1 || v.Field != "repoUrl" {
		t.Fatalf("unexpected violation: %v", err)
	}
}
