package local

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestPublishTransferRejectsMissingAndInvalidSources(t *testing.T) {
	s, _ := newStorage(t)
	n := transferNamespace(t, transferID)
	target, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, "file")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PublishTransferAttachment(t.Context(), n, "../escape", target); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid object: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := s.PublishTransferAttachment(ctx, n, objectID, target); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled publication: %v", err)
	}
	if err := s.PublishTransferAttachment(t.Context(), n, objectID, target); !errors.Is(err, fs.ErrNotExist) || filestorage.PublicationOutcome(err) != filestorage.NotPublished {
		t.Fatalf("missing namespace: %v", err)
	}
	if _, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("staged")); err != nil {
		t.Fatal(err)
	}
	if err := s.PublishTransferAttachment(t.Context(), n, otherTransferID, target); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing object: %v", err)
	}
	object, err := s.OpenTransfer(t.Context(), n, objectID)
	if err != nil {
		t.Fatalf("existing staged object changed: %v", err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPublishTransferDirectorySyncFailureRetainsOutcome(t *testing.T) {
	s, _ := newStorage(t)
	n := transferNamespace(t, transferID)
	target, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, "file")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("staged")); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("directory sync failed")
	s.fileSync = func(*os.File) error { return cause }
	err = s.PublishTransferAttachment(t.Context(), n, objectID, target)
	if !errors.Is(err, cause) || filestorage.PublicationOutcome(err) != filestorage.Published {
		t.Fatalf("publication outcome: %v", err)
	}
	if got := string(read(t, s, "task-attachments", target.Path())); got != "staged" {
		t.Fatalf("target = %q", got)
	}
}

func TestPublishTransferRejectsTargetPathConflicts(t *testing.T) {
	for _, test := range []struct{ name, existing, target string }{
		{"file ancestor", "parent", "parent/file"},
		{"nonempty directory", "parent/child", "parent"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _ := newStorage(t)
			n := transferNamespace(t, transferID)
			current, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, test.existing)
			if err != nil {
				t.Fatal(err)
			}
			target, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, test.target)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Put(t.Context(), "task-attachments", current.Path(), strings.NewReader("existing")); err != nil {
				t.Fatal(err)
			}
			if _, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("staged")); err != nil {
				t.Fatal(err)
			}
			if err := s.PublishTransferAttachment(t.Context(), n, objectID, target); err == nil {
				t.Fatal("conflicting target accepted")
			}
			for _, open := range []func() (filestorage.Object, error){
				func() (filestorage.Object, error) { return s.Open(t.Context(), "task-attachments", current.Path()) },
				func() (filestorage.Object, error) { return s.OpenTransfer(t.Context(), n, objectID) },
			} {
				object, err := open()
				if err != nil {
					t.Fatalf("conflict changed existing content: %v", err)
				}
				if err := object.Body.Close(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
