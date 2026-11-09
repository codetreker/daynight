//go:build integration

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
)

type processIdentity struct {
	PID        int    `json:"pid"`
	StartTicks string `json:"startTicks"`
	Executable string `json:"executable"`
}

type ownedResources struct {
	DatabaseURL     string           `json:"databaseUrl"`
	Schema          string           `json:"schema"`
	StorageRoot     string           `json:"storageRoot"`
	Server          *processIdentity `json:"server,omitempty"`
	Gateway         *processIdentity `json:"gateway,omitempty"`
	GatewayRoot     string           `json:"gatewayRoot,omitempty"`
	GatewayCallback string           `json:"gatewayCallback,omitempty"`
}

func dropOwnedSchema(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var resources ownedResources
	if err := json.Unmarshal(data, &resources); err != nil {
		return err
	}
	if !regexp.MustCompile(`^api_[a-z0-9]+$`).MatchString(resources.Schema) || resources.DatabaseURL == "" {
		return errors.New("invalid integration schema cleanup receipt")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := pgx.Connect(ctx, resources.DatabaseURL)
	if err != nil {
		return err
	}
	_, dropErr := connection.Exec(ctx, "DROP SCHEMA IF EXISTS "+pgx.Identifier{resources.Schema}.Sanitize()+" CASCADE")
	return errors.Join(dropErr, connection.Close(ctx))
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Usage: integration-cleanup <private-resource-receipt>")
		os.Exit(2)
	}
	if err := dropOwnedSchema(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, "integration schema cleanup failed:", err)
		os.Exit(1)
	}
}
