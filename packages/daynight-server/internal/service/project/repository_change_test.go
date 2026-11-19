package project

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRepositoryObservationAuthorizationMustRemainCurrent(t *testing.T) {
	admin, member := model.ProjectAdmin, model.ProjectMemberRole
	before := repositorySnapshot{}
	before.github.Access.TeamRole = &admin
	for _, current := range []*model.ProjectRole{nil, &member} {
		after := before
		after.github.Access.TeamRole = current
		if relevantGitHubFacts(before, after) {
			t.Fatal("accepted evidence after Team administration changed")
		}
	}
	if !relevantGitHubFacts(before, before) {
		t.Fatal("rejected unchanged observation facts")
	}
}
