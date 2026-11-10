package sessionprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSharedImageIntentVectors(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	file := filepath.Join(filepath.Dir(source), "../../../../../daynight/test/session/fixtures/image-intent-vectors.json")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name      string          `json:"name"`
		Command   json.RawMessage `json:"command"`
		Canonical string          `json:"canonical"`
		SHA256    string          `json:"sha256"`
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 7 {
		t.Fatal("shared vectors are incomplete")
	}
	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			command, err := DecodeCommand(vector.Command)
			if err != nil {
				t.Fatal("shared command rejected", err)
			}
			raw, _ := json.Marshal(command)
			var intent map[string]any
			if err = json.Unmarshal(raw, &intent); err != nil {
				t.Fatal(err)
			}
			delete(intent, "requestId")
			canonical, err := CanonicalImageJSON(intent)
			if err != nil || string(canonical) != vector.Canonical {
				t.Fatalf("canonical mismatch: got %s want %s error %v", canonical, vector.Canonical, err)
			}
			sum := sha256.Sum256(canonical)
			if hex.EncodeToString(sum[:]) != vector.SHA256 {
				t.Fatal("canonical digest differs across consumers")
			}
		})
	}
}
