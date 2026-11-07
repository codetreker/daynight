package project

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestProjectHTTPMetadataLimitsPreserveRows(t *testing.T) {
	h := projectRoutesHarness(t)
	urlPrefix := "https://example.com/"
	maxURL := urlPrefix + strings.Repeat("r", 4096-len(urlPrefix))
	body := func(name, repo string) string {
		return fmt.Sprintf(`{"name":%q,"repoUrl":%q,"expectedUserId":%q}`, name, repo, h.adminID)
	}
	for _, pair := range [][2]string{
		{strings.Repeat("a", 256), "host:one"},
		{strings.Repeat("😀", 256), maxURL},
		{"Legacy HTTPS syntax", "https://-host/repo"},
		{"Legacy SSH syntax", "ssh://git@host!name/repo"},
		{"Legacy SCP syntax", "git@服务:repo"},
	} {
		created := decodeResponse[api.ProjectDocument](t, h.call("POST", "/api/v1/projects", body(pair[0], pair[1]), h.admin), 201)
		if created.Name != pair[0] || created.RepoURL != pair[1] {
			t.Fatal("boundary input changed")
		}
	}
	snapshot := func() string {
		t.Helper()
		var state string
		err := h.Database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY team_id,user_id) FROM team_members m),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'ownership',(SELECT jsonb_agg(to_jsonb(o) ORDER BY project_id) FROM project_ownership o),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,user_id) FROM project_grants g))::text`).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	for _, pair := range [][2]string{{strings.Repeat("a", 257), "host:repo"}, {strings.Repeat("😀", 256) + "a", "host:repo"}, {"Project", maxURL + "r"}} {
		assertProjectError(t, h.call("POST", "/api/v1/projects", body(pair[0], pair[1]), h.admin), 400, "invalid_input")
	}
	if after := snapshot(); after != before {
		t.Fatal("rejected Project writes changed rows, ownership, grants or versions")
	}
}
