package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestSearchFailureLoggingKeepsClassificationAndHidesDetails(t *testing.T) {
	for _, tc := range []struct {
		err         error
		cause, code string
	}{
		{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Cause: errors.New("private SQL and cursor")}, "database", "internal_error"},
		{&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: context.Canceled}, "canceled", "internal_error"},
		{&model.Fault{Code: "search_timeout", Message: "private query", Cause: context.DeadlineExceeded}, "search_timeout", "search_timeout"},
	} {
		var out bytes.Buffer
		LogFailure(slog.New(slog.NewJSONHandler(&out, nil)), context.Background(), "task_search", "search", tc.err)
		var entry map[string]any
		if err := json.Unmarshal(out.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["cause"] != tc.cause || entry["error_code"] != tc.code || entry["diagnostic"] != "search operation failed" || strings.Contains(out.String(), "private") {
			t.Fatalf("unsafe or wrong classification: %s", out.String())
		}
	}
}
