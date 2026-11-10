package attachment

import (
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestFinalPagePreservesLargePathAndContentType(t *testing.T) {
	path := strings.Repeat(strings.Repeat("😀", 50)+"/", 20) + strings.Repeat("😀", 4)
	contentType := "text/plain; x=" + strings.Repeat("a", 4000)
	if utf8.RuneCountInString(path) != 1024 || len(path) != 4036 || len(contentType) != 4014 {
		t.Fatal("incorrect metadata boundary fixture")
	}
	const project = "a1111111-1111-4111-8111-111111111111"
	const task = "b2222222-2222-4222-8222-222222222222"
	now := time.Date(2026, 11, 11, 1, 2, 3, 4000, time.UTC)
	want := Page{Items: []model.Attachment{{ProjectID: project, TaskID: task, Path: path, ContentType: contentType, SizeBytes: 1, CreatedAt: now, UpdatedAt: now}}}
	input := store.AttachmentPage{Items: append([]model.Attachment{}, want.Items...)}
	got, err := MakePage(input, project, task)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("final page: got=%#v want=%#v error=%v", got, want, err)
	}
}
