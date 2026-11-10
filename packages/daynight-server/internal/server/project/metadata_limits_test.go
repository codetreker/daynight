package project

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestProjectHTTPMetadataLimitsPreserveValues(t *testing.T) {
	prefix := "https://example.com/"
	maxURL := prefix + strings.Repeat("r", 4096-len(prefix))
	for _, tc := range []struct {
		name, repo string
		refused    bool
	}{
		{strings.Repeat("a", 256), "host:one", false},
		{strings.Repeat("😀", 256), maxURL, false},
		{"Legacy HTTPS syntax", "https://-host/repo", false},
		{"Legacy SSH syntax", "ssh://git@host!name/repo", false},
		{"Legacy SCP syntax", "git@服务:repo", false},
		{strings.Repeat("a", 257), "host:repo", true},
		{strings.Repeat("😀", 256) + "a", "host:repo", true},
		{"Project", maxURL + "r", true},
	} {
		t.Run(fmt.Sprintf("%d bytes %d bytes refused=%v", len(tc.name), len(tc.repo), tc.refused), func(t *testing.T) {
			h := newHTTPHarness(t)
			h.Projects.CreateWithAccessFunc = func(_ context.Context, _ model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
				if input.Name != tc.name || input.RepoURL != tc.repo || input.ExpectedUserID != h.Principal.UserID || input.TeamID != nil {
					t.Fatalf("input=%+v", input)
				}
				if tc.refused {
					return model.Project{}, model.ProjectAccess{}, &model.Fault{Code: "invalid_input", Message: "Project metadata exceeds its limit"}
				}
				result := h.Project
				result.Name, result.RepoURL = tc.name, tc.repo
				return result, model.ProjectAccess{ProjectID: result.ID}, nil
			}
			body := fmt.Sprintf(`{"name":%q,"repoUrl":%q,"expectedUserId":%q}`, tc.name, tc.repo, h.Principal.UserID)
			response := h.call("POST", "/api/v1/projects", body)
			if tc.refused {
				assertProjectError(t, response, 400, "invalid_input")
			} else {
				created := decodeResponse[api.ProjectDocument](t, response, 201)
				if created.Name != tc.name || created.RepoURL != tc.repo {
					t.Fatal("boundary input changed")
				}
			}
			h.assertCalls(map[string]int{"CreateWithAccess": 1})
		})
	}
}
