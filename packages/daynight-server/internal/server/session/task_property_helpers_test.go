package session_test

import (
	"encoding/json"
	"testing"
)

func rawProperty(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
