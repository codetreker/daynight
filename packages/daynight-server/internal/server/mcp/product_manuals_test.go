package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func manualFixture(t *testing.T) (fstest.MapFS, []manualManifestEntry) {
	t.Helper()
	files := fstest.MapFS{}
	entries := append([]manualManifestEntry(nil), productManualManifest...)
	paths := []string{"manuals/instructions.md"}
	for _, entry := range entries {
		paths = append(paths, entry.Path)
	}
	for _, path := range paths {
		data, err := fs.ReadFile(productManualFS, path)
		if err != nil {
			t.Fatal(err)
		}
		files[path] = &fstest.MapFile{Data: data}
	}
	return files, entries
}

func manualDocumentNamed(t *testing.T, manuals productManuals, name string) manualDocument {
	t.Helper()
	for _, document := range manuals.Documents {
		if document.Resource.Name == name {
			return document
		}
	}
	t.Fatalf("missing manual %q", name)
	return manualDocument{}
}

func TestProductManualsCompleteAndUnmodified(t *testing.T) {
	manuals, err := loadProductManuals(productManualFS)
	if err != nil {
		t.Fatal(err)
	}
	wantURIs := []string{
		"daynight://manuals/concepts.md",
		"daynight://manuals/tasks.md",
		"daynight://manuals/dependencies.md",
		"daynight://manuals/write-safety.md",
		"daynight://manuals/materials.md",
		"daynight://manuals/steps.md",
		"daynight://manuals/threads.md",
		"daynight://manuals/attachment-reads.md",
		"daynight://manuals/attachment-writes.md",
		"daynight://manuals/session-reads.md",
		"daynight://manuals/session-messages.md",
		"daynight://manuals/worker-operations.md",
	}
	var gotURIs []string
	for _, document := range manuals.Documents {
		gotURIs = append(gotURIs, document.Resource.URI)
	}
	if !reflect.DeepEqual(gotURIs, wantURIs) {
		t.Fatalf("published URIs = %v; want %v", gotURIs, wantURIs)
	}
	instructions, err := fs.ReadFile(productManualFS, "manuals/instructions.md")
	if err != nil || manuals.Instructions != string(instructions) {
		t.Fatalf("instructions do not match source: %v", err)
	}
	for _, entry := range productManualManifest {
		document := manualDocumentNamed(t, manuals, entry.Resource.Name)
		body, err := fs.ReadFile(productManualFS, entry.Path)
		if err != nil || document.Text != string(body) || !reflect.DeepEqual(document.Resource, entry.Resource) || document.Resource.Size != int64(len(body)) {
			t.Fatalf("%s: source or metadata mismatch: %v", entry.Resource.Name, err)
		}
	}
	if !strings.Contains(manualDocumentNamed(t, manuals, "attachment-reads").Text, "[Design](docs/design.md)") {
		t.Fatal("attachment path example was changed")
	}
}

func TestProductManualValidation(t *testing.T) {
	tests := []struct {
		name string
		edit func(fstest.MapFS, *[]manualManifestEntry)
		want string
	}{
		{"missing topic", func(_ fstest.MapFS, entries *[]manualManifestEntry) { *entries = (*entries)[:len(*entries)-1] }, "topics"},
		{"duplicate", func(_ fstest.MapFS, entries *[]manualManifestEntry) { (*entries)[1] = (*entries)[0] }, "duplicate"},
		{"wrong topic", func(_ fstest.MapFS, entries *[]manualManifestEntry) { (*entries)[0].Resource.Name = "other" }, "invalid metadata"},
		{"bad mime", func(_ fstest.MapFS, entries *[]manualManifestEntry) { (*entries)[0].Resource.MIMEType = "text/plain" }, "invalid metadata"},
		{"missing file", func(files fstest.MapFS, _ *[]manualManifestEntry) { delete(files, "manuals/concepts.md") }, "concepts"},
		{"missing instructions", func(files fstest.MapFS, _ *[]manualManifestEntry) { delete(files, "manuals/instructions.md") }, "instructions"},
		{"invalid utf8", func(files fstest.MapFS, _ *[]manualManifestEntry) { files["manuals/concepts.md"].Data = []byte{0xff} }, "UTF-8"},
		{"empty instructions", func(files fstest.MapFS, _ *[]manualManifestEntry) {
			files["manuals/instructions.md"].Data = []byte(" \n")
		}, "nonempty"},
		{"incorrect size", func(_ fstest.MapFS, entries *[]manualManifestEntry) { (*entries)[0].Resource.Size++ }, "size mismatch"},
		{"unknown reference", func(files fstest.MapFS, entries *[]manualManifestEntry) {
			files["manuals/concepts.md"].Data = append(files["manuals/concepts.md"].Data, []byte("\n[bad](daynight://manuals/other.md)\n")...)
			(*entries)[0].Resource.Size = int64(len(files["manuals/concepts.md"].Data))
		}, "unknown product reference"},
		{"old relative reference", func(files fstest.MapFS, entries *[]manualManifestEntry) {
			files["manuals/concepts.md"].Data = append(files["manuals/concepts.md"].Data, []byte("\n[topic](materials.md)\n")...)
			(*entries)[0].Resource.Size = int64(len(files["manuals/concepts.md"].Data))
		}, "relative product reference"},
		{"unknown instructions reference", func(files fstest.MapFS, _ *[]manualManifestEntry) {
			files["manuals/instructions.md"].Data = append(files["manuals/instructions.md"].Data, []byte("\n[bad](daynight://manuals/other.md)\n")...)
		}, "unknown product reference"},
		{"relative instructions reference", func(files fstest.MapFS, _ *[]manualManifestEntry) {
			files["manuals/instructions.md"].Data = append(files["manuals/instructions.md"].Data, []byte("\n[topic](materials.md)\n")...)
		}, "relative product reference"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files, entries := manualFixture(t)
			tt.edit(files, &entries)
			got, err := loadManualManifest(files, entries)
			if err == nil || !strings.Contains(err.Error(), tt.want) || len(got.Documents) != 0 || got.Instructions != "" {
				t.Fatalf("got %#v, %v; want error containing %q and no result", got, err, tt.want)
			}
		})
	}
}

type failedManualFS struct{ err error }

func (f failedManualFS) Open(string) (fs.File, error) { return nil, f.err }

func TestProductManualReadPreservesError(t *testing.T) {
	cause := errors.New("fixture read failure")
	_, err := loadProductManuals(failedManualFS{err: cause})
	if !errors.Is(err, cause) || !strings.Contains(err.Error(), "instructions") {
		t.Fatalf("got %v, want wrapped source error", err)
	}
}

func TestProductManualVersionsAreIndependent(t *testing.T) {
	files, entries := manualFixture(t)
	first, err := loadManualManifest(files, entries)
	if err != nil {
		t.Fatal(err)
	}
	files["manuals/concepts.md"].Data = append(files["manuals/concepts.md"].Data, []byte("\nUpdated edition.\n")...)
	entries[0].Resource.Size = int64(len(files["manuals/concepts.md"].Data))
	second, err := loadManualManifest(files, entries)
	if err != nil {
		t.Fatal(err)
	}
	firstConcepts := manualDocumentNamed(t, first, "concepts")
	secondConcepts := manualDocumentNamed(t, second, "concepts")
	if firstConcepts.Resource.URI != secondConcepts.Resource.URI || firstConcepts.Text == secondConcepts.Text || strings.Contains(firstConcepts.Text, "Updated edition.") {
		t.Fatal("manual editions should have stable URI and independent complete text")
	}
}

func TestProductManualFailureHasSafeKey(t *testing.T) {
	files, entries := manualFixture(t)
	delete(files, "manuals/concepts.md")
	_, err := loadManualManifest(files, entries)
	var loadErr *manualLoadError
	if !errors.As(err, &loadErr) || loadErr.Key != "concepts" || !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("got %v; want concepts and wrapped not-exist error", err)
	}
}

func TestEntryRejectsInvalidManualSource(t *testing.T) {
	missing, _ := manualFixture(t)
	delete(missing, "manuals/concepts.md")
	privateError := errors.New("private storage credential and path")
	tests := []struct {
		name   string
		source fs.FS
		cause  error
		key    string
	}{
		{"missing topic", missing, fs.ErrNotExist, "concepts"},
		{"source failure", failedManualFS{err: privateError}, privateError, "instructions"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			entry, err := newWithManualSource(testAuthenticator{}, "https://daynight.test", nil, logger, nil, tt.source)
			var loadErr *manualLoadError
			if entry != nil || !errors.Is(err, tt.cause) || !errors.As(err, &loadErr) || loadErr.Key != tt.key {
				t.Fatalf("entry = %v, error = %v; want nil entry and wrapped %s failure", entry, err, tt.key)
			}
			var record map[string]any
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatalf("invalid log: %v", err)
			}
			for key, want := range map[string]string{"type": "operation_error", "component": "mcp", "phase": "manual_load", "document": tt.key} {
				if record[key] != want {
					t.Errorf("log %s = %v; want %s", key, record[key], want)
				}
			}
			if strings.Contains(logs.String(), privateError.Error()) {
				t.Fatal("log exposes underlying private error")
			}
		})
	}
}

func TestEntryRejectsInvalidConstructionArguments(t *testing.T) {
	logger := slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))
	for _, tt := range []struct {
		name   string
		auth   Authenticator
		origin string
		logger *slog.Logger
	}{
		{"missing auth", nil, "https://daynight.test", logger},
		{"missing logger", testAuthenticator{}, "https://daynight.test", nil},
		{"invalid origin", testAuthenticator{}, "not-an-origin", logger},
	} {
		t.Run(tt.name, func(t *testing.T) {
			entry, err := New(tt.auth, tt.origin, nil, tt.logger, nil)
			if entry != nil || err == nil {
				t.Fatalf("entry = %v, error = %v; want constructor rejection", entry, err)
			}
		})
	}
}
