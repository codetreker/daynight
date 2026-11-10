package server

import (
	"reflect"
	"testing"
)

func mcpAttachmentCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("MCP operation arguments: got %#v, want %#v", got, want)
		panic("MCP operation argument contract violated")
	}
}
