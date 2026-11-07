package session

import (
	"context"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestArchivePreflightDoesNotRevealSessionToNonmember(t *testing.T) {
	f := newServiceFixture(t)
	snapshot := f.registerWeb(t)
	outsider := testsupport.ServicePrincipal(t, f.db)
	for _, id := range []string{snapshot.SessionID, uuid.NewString()} {
		_, err := f.service.BeginArchive(context.Background(), outsider, f.project, f.task, id, core.ArchiveV1Read)
		requireServiceError(t, err, "forbidden")
	}
	_, err := f.service.BeginArchive(context.Background(), f.owner, f.project, f.task, uuid.NewString(), core.ArchiveV1Read)
	requireServiceError(t, err, "not_found")
	if httpx.ErrorKind(err) != "not_found" {
		t.Fatalf("missing session not classified as 404: %v", err)
	}
}
