package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"strings"
	"syscall"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
)

func TestArchiveMigrationCommandRejectsArgumentsBeforeConfiguration(t *testing.T) {
	var stdout, stderr bytes.Buffer
	reads := 0
	code := run(context.Background(), []string{"migrate-session-archive-layout", "sensitive-argument"}, func(string) string { reads++; return "" }, &stdout, &stderr)
	var event map[string]any
	if code != 1 || reads != 0 || stdout.Len() != 0 || json.Unmarshal(stderr.Bytes(), &event) != nil || event["category"] != "invalid_input" || strings.Contains(stderr.String(), "sensitive-argument") {
		t.Fatalf("archive maintenance arguments were not rejected safely: code=%d reads=%d stdout=%q stderr=%q", code, reads, &stdout, &stderr)
	}
}

func TestArchiveMigrationCommandUsesOnlyMaintenanceConfiguration(t *testing.T) {
	for _, values := range []map[string]string{{}, {"DAYNIGHT_DATABASE_URL": "postgres://user:top-secret@bad%host/db", "DAYNIGHT_STORAGE_ROOT": t.TempDir()}, {"DAYNIGHT_DATABASE_URL": "postgres://user:top-secret@127.0.0.1:1/db?connect_timeout=1", "DAYNIGHT_STORAGE_ROOT": t.TempDir()}} {
		var stdout, stderr bytes.Buffer
		code := run(context.Background(), []string{"migrate-session-archive-layout"}, func(key string) string {
			if key != "DAYNIGHT_DATABASE_URL" && key != "DAYNIGHT_STORAGE_ROOT" {
				t.Fatalf("archive maintenance read unrelated configuration %s", key)
			}
			return values[key]
		}, &stdout, &stderr)
		if code != 1 || stdout.Len() != 0 || strings.Contains(stderr.String(), "top-secret") || !strings.Contains(stderr.String(), `"component":"session_archive_layout_migration"`) {
			t.Fatalf("archive maintenance configuration failure leaked data: code=%d stdout=%q stderr=%q", code, &stdout, &stderr)
		}
	}
}

func TestArchiveMigrationCommandDoesNotStartSchemaMigrationOrHTTP(t *testing.T) {
	values := processAPIEnvironment(t)
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"migrate-session-archive-layout"}, func(key string) string {
		if key != "DAYNIGHT_DATABASE_URL" && key != "DAYNIGHT_STORAGE_ROOT" {
			t.Fatalf("unrelated configuration %s", key)
		}
		return values[key]
	}, &stdout, &stderr)
	if code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), `"category":"database"`) || strings.Contains(stderr.String(), `"phase":"listening"`) {
		t.Fatalf("archive migration bootstrapped an empty database or server: code=%d stdout=%q stderr=%q", code, &stdout, &stderr)
	}
}

func TestArchiveMigrationCommandOutputFailureCanBeVerifiedByRepeating(t *testing.T) {
	values := processAPIEnvironment(t)
	database, err := store.Open(context.Background(), values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	database.Close()
	getenv := func(key string) string {
		if key != "DAYNIGHT_DATABASE_URL" && key != "DAYNIGHT_STORAGE_ROOT" {
			t.Fatalf("unrelated configuration %s", key)
		}
		return values[key]
	}
	var stderr bytes.Buffer
	if code := run(context.Background(), []string{"migrate-session-archive-layout"}, getenv, attachmentMigrationOutputFailure{cause: errors.New("sensitive-output-path")}, &stderr); code != 1 || !strings.Contains(stderr.String(), `"category":"output"`) || strings.Contains(stderr.String(), "sensitive-output-path") {
		t.Fatalf("archive migration output failure was not exposed safely: code=%d stderr=%q", code, &stderr)
	}
	var stdout bytes.Buffer
	stderr.Reset()
	if code := run(context.Background(), []string{"migrate-session-archive-layout"}, getenv, &stdout, &stderr); code != 0 {
		t.Fatalf("archive migration could not be verified after output failure: code=%d stderr=%q", code, &stderr)
	}
	var summary sessionrelay.ArchiveLayoutMigrationSummary
	if err := json.Unmarshal(stdout.Bytes(), &summary); err != nil || summary.Phase != "complete" || summary.MovedCount != 0 {
		t.Fatalf("archive migration did not publish a verified completion: %q %v", &stdout, err)
	}
}

func TestArchiveMigrationFailureDiagnosticsRetainSafeCauseCategories(t *testing.T) {
	for _, cause := range []error{errors.New("sensitive-path"), fs.ErrPermission, fs.ErrNotExist, syscall.EXDEV, context.Canceled} {
		var output bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&output, nil))
		logArchiveMigrationFailure(context.Background(), logger, &sessionrelay.ArchiveLayoutMigrationError{Phase: "placing", Category: "filesystem", SessionID: "original-session", Diagnostic: "Archive directory move failed.", Cause: cause})
		var event map[string]any
		if json.Unmarshal(output.Bytes(), &event) != nil || event["sessionId"] != "original-session" || event["phase"] != "placing" || strings.Contains(output.String(), "sensitive-path") {
			t.Fatalf("unsafe archive migration diagnostic: %q", &output)
		}
	}
	logArchiveMigrationFailure(context.Background(), slog.New(slog.NewJSONHandler(io.Discard, nil)), errors.New("unclassified sensitive error"))
}
