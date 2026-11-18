package v2

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRecordingSourceProvenance(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..", "..", "daynight", "test", "session", "fixtures", "v2")
	raw, err := os.ReadFile(filepath.Join(root, "responsibility-digests.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		EmptySourceSHA256 string `json:"emptySourceSha256"`
		Cases             []struct{ File, Generation, SourceSHA256 string }
	}
	if err = json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if EmptySourceDigest() != corpus.EmptySourceSHA256 {
		t.Fatal("empty source digest differs from shared vector")
	}
	for _, example := range corpus.Cases {
		t.Run(example.File+"/"+example.Generation, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(root, example.File))
			if err != nil {
				t.Fatal(err)
			}
			archive, err := DecodeArchive(data)
			if err != nil {
				t.Fatal(err)
			}
			digest, err := SourceDigest(archive, example.Generation)
			if err != nil || digest != example.SourceSHA256 {
				t.Fatalf("source digest %s: %v", digest, err)
			}
			if _, err = SourceDigest(archive, "1001"); err == nil {
				t.Fatal("unknown run accepted")
			}
		})
	}
}

func TestProvenanceRejectsInvalidProducerBytes(t *testing.T) {
	// encoding/json would silently replace malformed UTF-8 and hash different
	// bytes. Provenance must fail instead of attributing that replacement to a source.
	invalidText := string([]byte{0xff})
	archive := Archive{Runs: []Run{{ExecutionGeneration: "1", SegmentIDs: []string{"segment"}}}, Files: []FrameFile{{SegmentID: "segment", Data: invalidText}}}
	if _, err := SourceDigest(archive, "1"); err == nil {
		t.Fatal("invalid source bytes acquired a digest")
	}
}
