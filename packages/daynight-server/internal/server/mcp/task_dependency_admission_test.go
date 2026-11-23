package mcp

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTaskDependencyUnionBoundPrecedesIDParsing(t *testing.T) {
	ordinary := strings.Split(strings.Repeat("invalid,", 29)+"invalid", ",")
	external := []string{"also-invalid"}
	_, _, err := compileTaskDependencies(&ordinary, &external)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" || !strings.Contains(fault.Message, "31") || !strings.Contains(fault.Message, "30") {
		t.Fatalf("expected dependency count refusal before UUID parsing: %v", err)
	}
}

func TestTaskDependencyPartitionAtLimit(t *testing.T) {
	ids := make([]string, 30)
	for i := range ids {
		ids[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
	}
	for _, n := range []int{0, 15, 30} {
		ordinary, external := ids[:n], ids[n:]
		all, ext, err := compileTaskDependencies(&ordinary, &external)
		if err != nil || all == nil || ext == nil || !slices.Equal(*all, ids) || !slices.Equal(*ext, external) {
			t.Fatalf("ordinary=%d: all=%v external=%v err=%v", n, all, ext, err)
		}
	}
}
