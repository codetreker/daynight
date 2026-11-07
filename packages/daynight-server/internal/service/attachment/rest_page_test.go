package attachment

import (
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRESTPageUsesEncodedBudgetWithoutSkipping(t *testing.T) {
	service, _, database, _, task, principal := attachmentService(t)
	ctx := t.Context()
	for _, path := range []string{"a", "b", "c"} {
		_, err := database.Pool.Exec(ctx, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,$3,$4,1)`, task.ProjectID, task.ID, path, strings.Repeat("<", 200000))
		if err != nil {
			t.Fatal(err)
		}
	}
	request := model.PageRequest{Limit: 100}
	for _, want := range []string{"a", "b", "c"} {
		page, err := service.ListREST(ctx, principal, task.ProjectID, task.ID, request)
		if err != nil || len(page.Items) != 1 || page.Items[0].Path != want {
			t.Fatalf("page for %s: %+v %v", want, page, err)
		}
		if (want == "c") != (page.NextCursor == nil) {
			t.Fatalf("cursor for %s: %v", want, page.NextCursor)
		}
		request.Cursor = page.NextCursor
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE task_attachments SET content_type=$1 WHERE task_id=$2 AND path='a'`, strings.Repeat("x", 2<<20), task.ID); err != nil {
		t.Fatal(err)
	}
	_, err := service.ListREST(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 100})
	requireFault(t, err, "resource_limit_exceeded")
}
