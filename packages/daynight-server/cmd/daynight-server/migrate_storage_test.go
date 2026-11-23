//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func TestMigrationArgumentsRequireAnExplicitSource(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		valid bool
	}{
		{"explicit pair", []string{"migrate-storage", "--root=/target", "--source-storage-root=/source"}, true},
		{"missing source", []string{"migrate-storage", "--root=/target"}, false},
		{"empty source", []string{"migrate-storage", "--source-storage-root="}, false},
		{"relative source", []string{"migrate-storage", "--source-storage-root=source"}, false},
		{"control source", []string{"migrate-storage", "--source-storage-root=/source\nsecret"}, false},
		{"duplicate source", []string{"migrate-storage", "--source-storage-root=/one", "--source-storage-root=/two"}, false},
		{"source on server", []string{"--source-storage-root=/source"}, false},
		{"source on verifier", []string{"verify-storage", "--source-storage-root=/source"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options, err := parseCommand(tc.args, lookupTestEnvironment(nil))
			if (err == nil) != tc.valid {
				t.Fatalf("options=%+v error=%v", options, err)
			}
			if tc.valid && (options.command != "migrate-storage" || options.root != "/target" || options.sourceStorageRoot != "/source") {
				t.Fatalf("lost source or target identity: %+v", options)
			}
		})
	}
}

func TestMigrationCommandCopiesVerifiedSourceAndRejectsLostSource(t *testing.T) {
	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	if connection == "" {
		t.Skip("requires isolated Azurite")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	values := processAPIEnvironment(t)
	database, err := postgres.Open(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	name := "migration-command-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	target, err := container.NewClientFromConnectionString(connection, name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = target.Create(ctx, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if _, err := target.Delete(cleanup, nil); err != nil {
			t.Error(err)
		}
	})
	address, err := attachment.NewAddress(uuid.NewString(), uuid.NewString(), "文档/sample.txt")
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("paired attachment")
	if _, err = database.Pool.Exec(ctx, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,$3,'text/plain',$4)`, address.ProjectID, address.TaskID, address.RelativePath, len(body)); err != nil {
		t.Fatal(err)
	}
	sourceRoot := t.TempDir()
	source, err := local.New(sourceRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.Put(ctx, attachment.Bucket, address.StoragePath, bytes.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	if err = source.Close(); err != nil {
		t.Fatal(err)
	}
	values["DAYNIGHT_STORAGE_BACKEND"] = "azure-blob"
	values["DAYNIGHT_STORAGE_AZURE_CONTAINER"] = name
	values["DAYNIGHT_STORAGE_AZURE_CONNECTION_STRING"] = connection
	args := []string{"migrate-storage", "--root", testStorageRoot(t), "--source-storage-root", sourceRoot}
	for _, status := range []string{"target_verified", "reused"} {
		var output bytes.Buffer
		if code := run(ctx, args, lookupTestEnvironment(values), &output); code != 0 || !strings.Contains(output.String(), status) || !strings.Contains(output.String(), "Storage migration verified.") {
			t.Fatalf("code=%d output=%s", code, &output)
		}
	}
	blobName, err := azure.BlobName(attachment.Bucket, address.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	object, err := target.NewBlobClient(blobName).DownloadStream(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	actual, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(actual, body) {
		t.Fatal("target bytes", string(actual), readErr, closeErr)
	}
	if err = os.Remove(sourceRoot + "/" + attachment.Bucket + "/" + address.StoragePath); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := run(ctx, args, lookupTestEnvironment(values), &output); code != 1 || !strings.Contains(output.String(), "source_missing") || strings.Contains(output.String(), "Storage migration verified.") {
		t.Fatalf("lost source accepted: code=%d output=%s", code, &output)
	}
}

func TestMigrationRejectsConfigurationBeforeBusinessResources(t *testing.T) {
	for _, tc := range []struct {
		name    string
		env     map[string]string
		message string
	}{
		{"missing database", nil, "configuration"},
		{"local target", map[string]string{"DAYNIGHT_DATABASE_URL": "postgres://localhost/unused"}, "explicit Azure target"},
		{"missing container", map[string]string{"DAYNIGHT_DATABASE_URL": "postgres://localhost/unused", "DAYNIGHT_STORAGE_BACKEND": "azure-blob"}, "configuration"},
		{"invalid backend", map[string]string{"DAYNIGHT_DATABASE_URL": "postgres://localhost/unused", "DAYNIGHT_STORAGE_BACKEND": "invalid-secret"}, "configuration"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			code := run(t.Context(), []string{"migrate-storage", "--root", testStorageRoot(t), "--source-storage-root=/unopened-secret-source"}, lookupTestEnvironment(tc.env), &output)
			if code != 1 || !strings.Contains(output.String(), tc.message) || strings.Contains(output.String(), "invalid-secret") || strings.Contains(output.String(), "unopened-secret-source") {
				t.Fatalf("code=%d output=%s", code, &output)
			}
		})
	}
}
