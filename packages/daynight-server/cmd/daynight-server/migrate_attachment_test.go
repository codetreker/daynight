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

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func TestMigrationCommandRejectsInvalidArgumentsBeforeConfiguration(t *testing.T) {
	for _, args := range [][]string{{"unknown-secret"}, {"migrate-attachment-layout"}, {"migrate-attachment-layout", "plan", "extra"}, {"migrate-attachment-layout", "apply"}, {"migrate-attachment-layout", "resume", "--unknown", "value"}, {"migrate-attachment-layout", "plan", "--operation-id", "id"}} {
		var stdout, stderr bytes.Buffer
		reads := 0
		code := run(context.Background(), args, func(string) string { reads++; return "" }, &stdout, &stderr)
		var event map[string]any
		if code != 1 || reads != 0 || stdout.Len() != 0 || json.Unmarshal(stderr.Bytes(), &event) != nil || event["category"] != "invalid_input" || strings.Contains(stderr.String(), "unknown-secret") {
			t.Fatalf("invalid maintenance arguments were not safely rejected: code=%d reads=%d stdout=%q stderr=%q", code, reads, stdout.String(), stderr.String())
		}
	}
}

func TestMigrationCommandRequiresOnlyMaintenanceConfiguration(t *testing.T) {
	for _, values := range []map[string]string{
		{},
		{"DAYNIGHT_DATABASE_URL": "postgres://user:top-secret@bad%host/db", "DAYNIGHT_STORAGE_ROOT": t.TempDir()},
		{"DAYNIGHT_DATABASE_URL": "postgres://user:top-secret@127.0.0.1:1/db?connect_timeout=1", "DAYNIGHT_STORAGE_ROOT": t.TempDir()},
	} {
		var stdout, stderr bytes.Buffer
		if code := run(context.Background(), []string{"migrate-attachment-layout", "plan"}, func(key string) string {
			if key != "DAYNIGHT_DATABASE_URL" && key != "DAYNIGHT_STORAGE_ROOT" {
				t.Fatalf("maintenance loaded unrelated configuration %s", key)
			}
			return values[key]
		}, &stdout, &stderr); code != 1 || stdout.Len() != 0 || strings.Contains(stderr.String(), "top-secret") || !strings.Contains(stderr.String(), `"component":"attachment_layout_migration"`) {
			t.Fatalf("maintenance configuration failure was unsafe: code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
		}
	}
	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"migrate-attachment-layout", "resume", "--operation-id", "invalid"}, func(string) string { return "" }, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), `"category":"invalid_input"`) {
		t.Fatal("invalid operation ID did not fail before configuration access")
	}
}

func TestMigrationFailureDiagnosticsPreserveSafeCauseCategories(t *testing.T) {
	for _, cause := range []error{errors.New("sensitive-path"), fs.ErrPermission, fs.ErrNotExist, syscall.EXDEV, context.Canceled} {
		var output bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&output, nil))
		logAttachmentMigrationFailure(context.Background(), logger, &service.AttachmentMigrationError{OperationID: "operation", Phase: "placing", Category: "filesystem", Diagnostic: "Directory move failed.", Cause: cause})
		var event map[string]any
		if json.Unmarshal(output.Bytes(), &event) != nil || event["operationId"] != "operation" || event["phase"] != "placing" || strings.Contains(output.String(), "sensitive-path") {
			t.Fatalf("unsafe migration diagnostic: %s", &output)
		}
	}
	logAttachmentMigrationFailure(context.Background(), slog.New(slog.NewJSONHandler(io.Discard, nil)), errors.New("unclassified sensitive error"))
}
