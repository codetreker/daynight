package filestorage

import (
	"errors"
	"strings"
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

func TestTransferAttachmentTarget(t *testing.T) {
	const project = "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
	const task = "70b6f95f-23d4-4a9e-9f93-f24f29c066a9"
	const relative = "设计 文档/a%_?#.bin"
	target, err := NewTransferAttachmentTarget(project, task, relative)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := target.Path(), project+"/70/"+task+"/"+relative; got != want {
		t.Fatalf("target path = %q, want %q", got, want)
	}
	for _, test := range []struct {
		name, project, task, path string
	}{
		{"invalid project", "not-a-uuid", task, relative},
		{"zero project", "00000000-0000-0000-0000-000000000000", task, relative},
		{"noncanonical project", strings.ToUpper(project), task, relative},
		{"invalid task", project, "not-a-uuid", relative},
		{"zero task", project, "00000000-0000-0000-0000-000000000000", relative},
		{"noncanonical task", project, strings.ToUpper(task), relative},
		{"empty path", project, task, ""},
		{"parent path", project, task, "../escape"},
		{"backslash", project, task, `folder\file`},
	} {
		t.Run(test.name, func(t *testing.T) {
			target, err := NewTransferAttachmentTarget(test.project, test.task, test.path)
			if !errors.Is(err, ErrInvalidAddress) || target.Path() != "" {
				t.Fatalf("invalid target = %q, error = %v", target.Path(), err)
			}
		})
	}
}
