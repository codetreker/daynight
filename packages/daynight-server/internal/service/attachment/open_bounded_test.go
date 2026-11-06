package attachment

import (
	"io"
	"testing"
)

func TestOpenBoundedRejectsOversizedMetadataWithoutChangingOrdinaryOpen(t *testing.T) {
	service, _, _, _, task, principal := attachmentService(t)
	expected := putAttachment(t, service, principal, task, "file", "content")
	if _, _, err := service.OpenBounded(t.Context(), principal, task.ProjectID, task.ID, "file", 0); err == nil {
		t.Fatal("zero metadata limit accepted")
	}
	if _, _, err := service.OpenBounded(t.Context(), principal, task.ProjectID, task.ID, "file", len(expected.ContentType)-1); err == nil {
		t.Fatal("oversized metadata accepted")
	}
	metadata, obj, err := service.OpenBounded(t.Context(), principal, task.ProjectID, task.ID, "file", len(expected.ContentType))
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(obj.Body)
	_ = obj.Body.Close()
	if err != nil || string(b) != "content" || metadata.ContentType != expected.ContentType {
		t.Fatalf("bounded source: %+v %q %v", metadata, b, err)
	}
	metadata, obj, err = service.Open(t.Context(), principal, task.ProjectID, task.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	_ = obj.Body.Close()
	if metadata.ContentType != expected.ContentType {
		t.Fatal("ordinary read changed")
	}
}
