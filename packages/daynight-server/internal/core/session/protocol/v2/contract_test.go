package v2

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalJSONAndVersionSelection(t *testing.T) {
	encoded, err := CanonicalJSON(map[string]any{"z": float64(1), "a": "<>&\u2028\u2029"})
	if err != nil || string(encoded) != "{\"a\":\"<>&\u2028\u2029\",\"z\":1}" {
		t.Fatalf("canonical encoding: %s %v", encoded, err)
	}
	for _, selection := range []string{"daynight.session.v1", "daynight.session.v2"} {
		if _, err := SelectProtocol(&selection); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := SelectProtocol(pointer("daynight.session.v3")); err == nil {
		t.Fatal("unknown selection accepted")
	}
}

func TestSharedFixtures(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..", "..", "daynight", "test", "session", "fixtures", "v2")
	data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Cases []struct {
			File  string
			Type  string
			Valid bool
		}
	}
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range manifest.Cases {
		t.Run(fixture.File, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(root, fixture.File))
			if err != nil {
				t.Fatal(err)
			}
			if fixture.Type != "archive" {
				t.Fatalf("unknown fixture type %s", fixture.Type)
			}
			_, err = DecodeArchive(raw)
			if (err == nil) != fixture.Valid {
				t.Fatalf("valid=%v, error=%v", fixture.Valid, err)
			}
		})
	}
}

func pointer[T any](value T) *T { return &value }
