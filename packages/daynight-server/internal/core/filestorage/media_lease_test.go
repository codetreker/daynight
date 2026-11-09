package filestorage_test

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
)

func TestMediaLeaseRecoveryUsesTheLiveOwnersExactFilesystemGate(t *testing.T) {
	root := t.TempDir()
	owner, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	recovery, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.Close()
	gate, err := owner.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "original")
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	if _, err = filestorage.TryAcquireMediaLease(t.Context(), recovery, "original"); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatal("recovery split the live owner lock", err)
	}
	if _, err = filestorage.TryAcquireMediaLease(t.Context(), recovery, ""); err == nil {
		t.Fatal("empty recovery key accepted")
	}
	if err = gate.Close(); err != nil {
		t.Fatal(err)
	}
	permit, err := filestorage.TryAcquireMediaLease(t.Context(), recovery, "original")
	if err != nil {
		t.Fatal(err)
	}
	if err = permit.Close(); err != nil {
		t.Fatal(err)
	}
}
