//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestIntegrationSchemaCleanup(t *testing.T) {
	root := integrationRunRoot(t)
	database := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if database == "" {
		t.Fatal("schema cleanup checks require the integration runner's owned environment")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	connection, err := pgx.Connect(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	schema := "api_" + strings.ToLower(rand.Text())
	storage := filepath.Join(root, "storage")
	path := filepath.Join(root, "resources.json")
	t.Cleanup(func() {
		cleanup, finish := context.WithTimeout(context.Background(), 10*time.Second)
		defer finish()
		_, dropErr := connection.Exec(cleanup, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
		if err := errors.Join(dropErr, connection.Close(cleanup), os.RemoveAll(storage)); err != nil {
			t.Error(err)
		}
	})
	if err := os.Mkdir(storage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeOwnedResources(path, ownedResources{DatabaseURL: database, Schema: schema, StorageRoot: storage}); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, filepath.Join(root, "cleanup"), path)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	var targetExists, publicExists bool
	if err := connection.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1), EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public')", schema).Scan(&targetExists, &publicExists); err != nil {
		t.Fatal(err)
	}
	if targetExists || !publicExists {
		t.Fatal("schema cleanup did not preserve its namespace ownership")
	}
	invalid := filepath.Join(root, "invalid-schema.json")
	if err := writeOwnedResources(invalid, ownedResources{DatabaseURL: database, Schema: "public", StorageRoot: storage}); err != nil {
		t.Fatal(err)
	}
	command = exec.CommandContext(ctx, filepath.Join(root, "cleanup"), invalid)
	var diagnostic bytes.Buffer
	stream := io.MultiWriter(os.Stdout, &diagnostic)
	command.Stdout, command.Stderr = stream, stream
	var exit *exec.ExitError
	if !errors.As(command.Run(), &exit) || !strings.Contains(diagnostic.String(), "invalid integration schema cleanup receipt") {
		t.Fatal("cleanup accepted a namespace outside its ownership contract")
	}
	if err := connection.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='public')").Scan(&publicExists); err != nil || !publicExists {
		t.Fatalf("invalid cleanup changed the shared namespace: %v", err)
	}
}
