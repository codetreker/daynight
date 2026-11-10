package session

import (
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func historyImageProjectionEntry(t *testing.T, container, status string) (sp.TimelineEntry, sp.Resource) {
	t.Helper()
	image, resourceID := uuid.NewString(), uuid.NewString()
	media, length, digest := "image/png", "1", strings.Repeat("a", 64)
	resource := sp.Resource{ResourceID: resourceID, Status: "available", Name: "original", MediaType: &media, ByteLength: &length, SHA256: &digest}
	part := map[string]any{"type": "image", "imageId": image, "resourceId": resourceID, "label": "original"}
	if status == "unavailable" {
		part = map[string]any{"type": "image_unavailable", "imageId": image, "label": "original", "error": sp.ImageError{Code: "source_unavailable", Message: "Original unavailable."}}
	}
	entry := map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "imageProjectionError": nil, "content": []any{part}}
	if container == "tool" {
		entry["kind"], entry["callId"], entry["name"], entry["input"], entry["output"], entry["status"], entry["truncated"] = "tool_call", "call", "read", "", []any{part}, "completed", false
		delete(entry, "content")
	} else if container != "direct" {
		text := "![original](image.png)"
		binding := map[string]any{"imageId": image, "start": 0, "end": len(text), "part": part}
		markdown := map[string]any{"partId": uuid.NewString(), "revision": "1", "textSha256": v2.HashBytes([]byte(text)), "complete": true, "truncated": false, "bindings": []any{binding}, "retainedImages": []any{}}
		if strings.HasSuffix(container, "retained") {
			binding["sourceRevision"], binding["sourceTextSha256"], binding["linkHref"] = "1", v2.HashBytes([]byte(text)), nil
			markdown["bindings"], markdown["retainedImages"] = []any{}, []any{binding}
		}
		if status == "unresolved" {
			markdown["bindings"] = nil
			entry["imageProjectionError"] = sp.ImageError{Code: "source_unavailable", Message: "Projection pending."}
		}
		if strings.HasPrefix(container, "reasoning") {
			entry["kind"], entry["text"], entry["markdown"] = "reasoning", text, markdown
			delete(entry, "content")
		} else {
			markdown["type"], markdown["text"] = "markdown", text
			entry["content"] = []any{markdown}
		}
	}
	decoded, err := sp.DecodeTimeline(encode(entry))
	if err != nil {
		t.Fatal("image history fixture", err, string(encode(entry)))
	}
	return decoded, resource
}

func TestHistoryImageReferencesAndCoverageUseCompleteProjection(t *testing.T) {
	for _, container := range []string{"direct", "tool", "markdown_binding", "markdown_retained", "reasoning_binding", "reasoning_retained"} {
		for _, status := range []string{"available", "missing", "unavailable"} {
			t.Run(container+"/"+status, func(t *testing.T) {
				entry, resource := historyImageProjectionEntry(t, container, status)
				var resources []sp.Resource
				if status == "available" {
					resources = []sp.Resource{resource}
				}
				page, err := BuildHistoryPage(uuid.NewString(), "epoch", "archive", "version", []sp.TimelineEntry{entry}, resources, "", 20, false, 0, time.Now())
				if err != nil {
					t.Fatal(err)
				}
				if status == "available" {
					if len(page.Items[0].Resources) != 1 || page.Items[0].Resources[0].ResourceID != resource.ResourceID || page.Coverage.State != "complete" {
						t.Fatalf("image descriptor lost %#v", page)
					}
				} else if page.Coverage.State != "partial" || page.Coverage.Reason == nil || *page.Coverage.Reason != "resource_unavailable" {
					t.Fatalf("image gap reported complete %#v", page.Coverage)
				}
			})
		}
	}
	entry, _ := historyImageProjectionEntry(t, "reasoning_binding", "unresolved")
	page, err := BuildHistoryPage(uuid.NewString(), "epoch", "live", "epoch", []sp.TimelineEntry{entry}, nil, "", 20, true, 0, time.Now())
	if err != nil || len(page.Items) != 0 || page.Coverage.State != "partial" || page.Coverage.Reason == nil || *page.Coverage.Reason != "resource_unavailable" {
		t.Fatalf("unresolved projection lost after filtering %#v %v", page, err)
	}
}
