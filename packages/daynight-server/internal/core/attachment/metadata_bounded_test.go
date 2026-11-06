package attachment

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type boundedProbe struct {
	store.AttachmentReader
	item      model.Attachment
	oversized bool
	err       error
	limit     int
}

func (p *boundedProbe) AttachmentBounded(_ context.Context, _, _, _ string, limit int) (model.Attachment, bool, error) {
	p.limit = limit
	return p.item, p.oversized, p.err
}
func TestMetadataBounded(t *testing.T) {
	address := Address{ProjectID: "project", TaskID: "task", RelativePath: "file"}
	p := &boundedProbe{item: model.Attachment{Path: "file", ContentType: "text/plain"}}
	got, err := MetadataBounded(t.Context(), p, address, 10)
	if err != nil || got != p.item || p.limit != 10 {
		t.Fatalf("bounded read: %+v %v", got, err)
	}
	if _, err := MetadataBounded(t.Context(), p, address, 0); err == nil {
		t.Fatal("zero limit accepted")
	}
	p.oversized = true
	if _, err := MetadataBounded(t.Context(), p, address, 10); err == nil {
		t.Fatal("oversized metadata accepted")
	}
	failure := errors.New("database failure")
	for _, cause := range []error{model.ErrNotFound, failure} {
		p.err = cause
		if _, err := MetadataBounded(t.Context(), p, address, 10); !errors.Is(err, cause) {
			t.Fatalf("cause %v: %v", cause, err)
		}
	}
}
