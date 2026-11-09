package attachment_test

import (
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAttachmentStoreLiteralPrefixesAndUnicodePages(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		page, err := scope.AttachmentDAO().Attachments(ctx, projectID, taskID, store.AttachmentQuery{Limit: 2})
		if err != nil || page.Items == nil || len(page.Items) != 0 || page.HasMore {
			t.Fatalf("empty metadata page: %+v %v", page, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	want := []string{"a/file", "A/file", "中 文", "emoji-😀", "%literal", "_literal"}
	for _, path := range want {
		if _, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: "text/plain", SizeBytes: int64(len(path))}); err != nil {
			t.Fatal(err)
		}
	}
	for _, address := range [][2]string{{projectID, uuid.NewString()}, {uuid.NewString(), uuid.NewString()}} {
		if _, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: address[0], TaskID: address[1], Path: "a/file", ContentType: "text/plain", SizeBytes: 99}); err != nil {
			t.Fatal(err)
		}
	}
	slices.Sort(want)
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		query := store.AttachmentQuery{Limit: 2}
		var got []string
		for {
			page, err := scope.AttachmentDAO().Attachments(ctx, projectID, taskID, query)
			if err != nil {
				return err
			}
			for _, item := range page.Items {
				if item.ProjectID != projectID || item.TaskID != taskID || item.SizeBytes != int64(len(item.Path)) {
					t.Fatalf("page included another attachment scope: %+v", item)
				}
				got = append(got, item.Path)
			}
			if !page.HasMore {
				break
			}
			if len(got) > len(want) || len(page.Items) != 2 {
				t.Fatalf("pagination did not progress: %+v", page)
			}
			after := page.Items[len(page.Items)-1].Path
			query.After = &after
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("C-collation order: got=%q want=%q", got, want)
		}
		if _, err := scope.AttachmentDAO().Attachment(ctx, uuid.NewString(), taskID, "a/file"); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("mismatched Project read: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteAttachment(ctx, uuid.NewString(), taskID, "a/file"); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("mismatched Project delete: %v", err)
	}
	for _, path := range []string{"docs", "literal%_/child", "literalXX/child", "literal%", "literal_/file"} {
		if _, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: "text/plain", SizeBytes: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		for _, test := range []struct {
			ancestors []string
			prefix    string
			conflict  bool
		}{
			{[]string{"docs"}, "docs/child/", true},
			{[]string{}, "literal%_/", true},
			{[]string{}, "literal%/", false},
			{[]string{"literal_"}, "literal_/other/", false},
			{[]string{"literal%"}, "literal%/child/", true},
		} {
			got, err := scope.AttachmentDAO().AttachmentPathConflict(ctx, projectID, taskID, store.AttachmentConflictQuery{Ancestors: test.ancestors, DescendantPrefix: test.prefix})
			if err != nil || got != test.conflict {
				t.Fatalf("literal prefix %q, ancestors %q: got=%t want=%t err=%v", test.prefix, test.ancestors, got, test.conflict, err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentStoreRetainsLegacyPathAndContentType(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	path := strings.Repeat(strings.Repeat("界", 50)+"/", 20) + "界界界界"
	legacy, following := path+"x", path+"y"
	prefix, suffix := `text/plain; name="`, `"`
	limit := prefix + strings.Repeat("界", 676) + strings.Repeat("a", 2048-len(prefix)-len(suffix)-676*3) + suffix
	over := limit[:len(limit)-1] + "a" + suffix
	var expected []model.Attachment
	for _, item := range []model.Attachment{
		{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: limit, SizeBytes: 11},
		{ProjectID: projectID, TaskID: taskID, Path: legacy, ContentType: over, SizeBytes: 6},
		{ProjectID: projectID, TaskID: taskID, Path: following, ContentType: "text/plain", SizeBytes: 0},
	} {
		stored, _, err := database.PutAttachment(ctx, item)
		if err != nil {
			t.Fatal(err)
		}
		expected = append(expected, stored)
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		query := store.AttachmentQuery{Limit: 1}
		for index, want := range expected {
			page, err := scope.AttachmentDAO().Attachments(ctx, projectID, taskID, query)
			if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], want) || page.HasMore != (index < len(expected)-1) {
				t.Fatalf("legacy page %d: %+v %v", index, page, err)
			}
			after := want.Path
			query.After = &after
		}
		read, err := scope.AttachmentDAO().Attachment(ctx, projectID, taskID, legacy)
		if err != nil || !reflect.DeepEqual(read, expected[1]) || read.ContentType != over {
			t.Fatalf("legacy metadata read: %+v %v", read, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteAttachment(ctx, projectID, taskID, legacy); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentStoreSuppressedDeleteRetainsRow(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	before, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "file", ContentType: "text/plain; charset=utf-8", SizeBytes: 6})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION suppress_attachment_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_attachment_delete BEFORE DELETE ON task_attachments FOR EACH ROW EXECUTE FUNCTION suppress_attachment_delete()`); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteAttachment(ctx, projectID, taskID, "file"); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("suppressed delete reported success: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		after, err := scope.AttachmentDAO().Attachment(ctx, projectID, taskID, "file")
		if err != nil || !reflect.DeepEqual(after, before) {
			t.Fatalf("suppressed delete changed metadata: %+v %v", after, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
