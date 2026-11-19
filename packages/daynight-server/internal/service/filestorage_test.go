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

func TestConfiguredFileStorageRejectsInvalidDependencies(t *testing.T) {
	root := t.TempDir()
	if files, err := openFileStorage(root, "invalid Redis URL"); files != nil || err == nil {
		t.Fatalf("invalid Redis URL returned files=%v, error=%v", files, err)
	}
	occupied := filepath.Join(root, "occupied")
	if err := os.WriteFile(occupied, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if files, err := openFileStorage(occupied, "redis://127.0.0.1:1"); files != nil || err == nil {
		t.Fatalf("invalid root returned files=%v, error=%v", files, err)
	}
}
