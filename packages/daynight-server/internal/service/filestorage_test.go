package service

import (
	"crypto/rand"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestConfiguredFileStorageSharesRedisGate(t *testing.T) {
	redisURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if redisURL == "" {
		t.Skip("requires an isolated Redis test instance")
	}
	root := t.TempDir()
	first, err := openFileStorage(root, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := first.Close(); err != nil {
			t.Error(err)
		}
	})
	second, err := openFileStorage(t.TempDir(), redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := second.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, ok := first.(filestorage.TransferAttachmentPublisher); !ok {
		t.Fatal("Redis storage lost transfer publication capability")
	}
	key := rand.Text()
	permit, err := first.TryAcquireResidency(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := permit.Close(); err != nil {
			t.Error(err)
		}
	})
	if contested, err := second.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		if contested != nil {
			_ = contested.Close()
		}
		t.Fatalf("second storage residency error = %v, want gate busy", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".daynight-gates")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("check legacy gate directory: %v", err)
	}
}
