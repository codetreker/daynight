package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func verifyStorageCommand(ctx context.Context, getenv func(string) string, stderr io.Writer) int {
	database, root := getenv("DAYNIGHT_DATABASE_URL"), getenv("DAYNIGHT_STORAGE_ROOT")
	if strings.TrimSpace(database) == "" || strings.TrimSpace(root) == "" {
		fmt.Fprintln(stderr, "verify-storage requires DAYNIGHT_DATABASE_URL and DAYNIGHT_STORAGE_ROOT")
		return 1
	}
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := service.VerifyStorageBackup(ctx, database, root); err != nil {
		httpx.LogFailure(slog.New(slog.NewJSONHandler(stderr, nil)), ctx, "storage-backup", "verify", err)
		return 1
	}
	fmt.Fprintln(stderr, "Storage backup closure verified.")
	return 0
}
