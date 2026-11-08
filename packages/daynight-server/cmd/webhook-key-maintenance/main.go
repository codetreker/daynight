// webhook-key-maintenance inventories, rewraps, and compares restored webhook ciphertexts.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/jackc/pgx/v5/pgxpool"
)

var exit = os.Exit

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		exit(1)
	}
}

func loadKeyring(path string) (*secretbox.Keyring, error) {
	if path == "" {
		return nil, fmt.Errorf("keyring file is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open keyring: %w", err)
	}
	keys, readErr := secretbox.Read(file)
	closeErr := file.Close()
	if readErr != nil {
		return nil, fmt.Errorf("read keyring: %w", readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close keyring: %w", closeErr)
	}
	return keys, nil
}

func run(ctx context.Context, args []string, getenv func(string) string, output io.Writer) error {
	flags := flag.NewFlagSet("webhook-key-maintenance", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	mode := flags.String("mode", "inventory", "inventory, rewrap, or verify-restore")
	old := flags.String("old-master", "", "old master key ID")
	limit := flags.Int("limit", 500, "maximum candidates per pass (1-500)")
	timeout := flags.Duration("timeout", time.Hour, "maximum command duration (up to 24h)")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	if flags.NArg() != 0 || (*mode != "inventory" && *mode != "rewrap" && *mode != "verify-restore") {
		return fmt.Errorf("invalid maintenance mode or arguments")
	}
	if *timeout <= 0 || *timeout > 24*time.Hour {
		return fmt.Errorf("invalid maintenance timeout")
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	databaseURL := getenv("DAYNIGHT_DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DAYNIGHT_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("configure database: %w", err)
	}
	defer pool.Close()
	db := &postgres.Store{Pool: pool}
	encoder := json.NewEncoder(output)
	if *mode == "inventory" {
		ids, e := db.WebhookMasterKeyIDs(ctx)
		if e != nil {
			return e
		}
		// Online references alone do not prove producer drain or backup recoverability.
		return encoder.Encode(struct {
			MasterKeyIDs   []string `json:"masterKeyIds"`
			RetirementSafe bool     `json:"retirementSafe"`
		}{ids, false})
	}
	keys, err := loadKeyring(getenv("DAYNIGHT_WEBHOOK_KEYRING_FILE"))
	if err != nil {
		return err
	}
	if *mode == "rewrap" {
		result, e := (webhook.KeyMaintenance{DB: db, Keys: keys}).RewrapPass(ctx, *old, *limit)
		if outputErr := encoder.Encode(result); outputErr != nil {
			return fmt.Errorf("write result: %w", outputErr)
		}
		return e
	}
	restoredURL := getenv("DAYNIGHT_RESTORED_DATABASE_URL")
	if restoredURL == "" || restoredURL == databaseURL {
		return fmt.Errorf("a distinct isolated DAYNIGHT_RESTORED_DATABASE_URL is required")
	}
	restoredKeys, err := loadKeyring(getenv("DAYNIGHT_RESTORED_WEBHOOK_KEYRING_FILE"))
	if err != nil {
		return err
	}
	restoredPool, err := pgxpool.New(ctx, restoredURL)
	if err != nil {
		return fmt.Errorf("configure restored database: %w", err)
	}
	defer restoredPool.Close()
	count, err := webhook.VerifyKeyRecovery(ctx, db, &postgres.Store{Pool: restoredPool}, keys, restoredKeys, *old)
	if err != nil {
		return err
	}
	return encoder.Encode(struct {
		Compared       int  `json:"compared"`
		RetirementSafe bool `json:"retirementSafe"`
	}{count, false})
}
