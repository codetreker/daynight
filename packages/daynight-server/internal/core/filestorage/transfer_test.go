package filestorage

import (
	"errors"
	"testing"
)

func TestTransferNamespaceDirectoryAndObjectAddress(t *testing.T) {
	const transfer = "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
	const object = "70b6f95f-23d4-4a9e-9f93-f24f29c066a9"
	var empty TransferNamespace
	if empty.Directory() != "" {
		t.Fatal("invalid namespace produced a directory")
	}
	if _, err := empty.ObjectPath(object); !errors.Is(err, ErrInvalidAddress) {
		t.Fatalf("invalid namespace: %v", err)
	}
	ns, err := NewTransferNamespace(transfer)
	if err != nil {
		t.Fatal(err)
	}
	if ns.ID() != transfer || ns.Directory() != "75/"+transfer {
		t.Fatalf("namespace address: %q %q", ns.ID(), ns.Directory())
	}
	path, err := ns.ObjectPath(object)
	if err != nil || path != "75/"+transfer+"/"+object {
		t.Fatalf("object address: %q %v", path, err)
	}
	if _, err := ns.ObjectPath("../escape"); !errors.Is(err, ErrInvalidAddress) {
		t.Fatalf("invalid object: %v", err)
	}
}
