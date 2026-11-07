package session

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
)

func TestDeletedProjectSessionAdmissionReturnsNotFound(t *testing.T) {
	f := newServiceFixture(t)
	ctx := t.Context()
	v := f.connectWeb(t, f.registerWeb(t))
	outsider := testsupport.ServicePrincipal(t, f.db)
	_, err := f.service.Current(ctx, outsider, f.project, f.task)
	requireServiceError(t, err, "forbidden")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE projects SET deleted_at=now() WHERE id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Current(ctx, f.owner, f.project, f.task)
	requireServiceError(t, err, "not_found")
	_, _, _, err = f.service.BrowserPoll(ctx, f.owner, f.project, f.task, v.SessionID, "")
	requireServiceError(t, err, "not_found")
	_, err = f.service.SourceSeq(ctx, v.ControllerFence)
	requireServiceError(t, err, "not_found")
	_, err = f.service.ArchiveStatus(ctx, f.owner, f.project, f.task, v.SessionID)
	requireServiceError(t, err, "not_found")
	// Corrupt retained Task properties must not override the deleted Project gate.
	if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value='not-json' WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Current(ctx, f.owner, f.project, f.task)
	requireServiceError(t, err, "not_found")
	_, err = f.service.ArchiveStatus(ctx, f.owner, f.project, f.task, v.SessionID)
	requireServiceError(t, err, "not_found")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.ArchiveStatus(ctx, f.owner, f.project, f.task, v.SessionID)
	requireServiceError(t, err, "not_found")
}
