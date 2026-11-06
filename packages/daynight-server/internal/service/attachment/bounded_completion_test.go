package attachment

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestListBoundedRequiresPositiveFieldLimit(t *testing.T) {
	service := NewAttachments(nil, nil, nil)
	for _, limit := range []int{0, -1} {
		_, err := service.ListBounded(t.Context(), model.Principal{}, "", "", model.PageRequest{}, limit, limit)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" {
			t.Fatalf("limit %d: %v", limit, err)
		}
	}
}

func TestListBoundedPreservesAuthorizationAndMarksOversizedMetadata(t *testing.T) {
	service, _, _, _, task, principal := attachmentService(t)
	putAttachment(t, service, principal, task, "entry", "content")
	page, err := service.ListBounded(t.Context(), principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1}, 5, 5)
	if err != nil || len(page.Items) != 1 || page.Items[0].Path != "entry" || page.Items[0].ContentType != "" || len(page.Oversized) != 1 || !page.Oversized[0] {
		t.Fatalf("bounded metadata: %+v %v", page, err)
	}
	_, err = service.ListBounded(t.Context(), model.Principal{}, task.ProjectID, task.ID, model.PageRequest{Limit: 1}, 5, 5)
	if err == nil {
		t.Fatal("bounded list accepted an unauthenticated principal")
	}
}

func TestFileEffectErrorRetainsDiagnosticAndCause(t *testing.T) {
	cause := errors.New("delete failed")
	err := &fileEffectError{cause: cause}
	if err.Error() != cause.Error() || !errors.Is(err, cause) || !FileEffectPossible(err) {
		t.Fatalf("file effect error: %v", err)
	}
}
