package mcp

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTaskDependencyUnionBoundPrecedesIDParsing(t *testing.T) {
	ordinary := strings.Split(strings.Repeat("invalid,", 14)+"invalid", ",")
	external := []string{"also-invalid"}
	_, _, err := compileTaskDependencies(&ordinary, &external)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" || !strings.Contains(fault.Message, "15") {
		t.Fatalf("expected dependency count refusal before UUID parsing: %v", err)
	}
}
