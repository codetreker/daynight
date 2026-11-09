package session

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

func TestPrivateSavedResourceRefusalRetainsNotFoundAcrossServiceTransactions(t *testing.T) {
	f := newServiceFixture(t)
	snapshot := f.registerWeb(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	engine := core.NewEngine(files)
	defer engine.Stop(context.Background())
	service := New(f.db, engine)
	resource := uuid.NewString()
	if _, err := f.db.Pool.Exec(t.Context(), `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2::uuid,jsonb_build_object('resourceId',$2::uuid::text,'revision','1','status','available'),$2::uuid,'private/original')`, snapshot.SessionID, resource); err != nil {
		t.Fatal(err)
	}
	_, err = service.ReadResource(t.Context(), f.owner, f.project, f.task, snapshot.SessionID, sp.ImageReadRequest{ResourceID: resource, Offset: "0", Limit: 8})
	if httpx.ErrorKind(err) != "not_found" {
		t.Fatal("private resource refusal lost its HTTP 404 mapping", err)
	}
	_, _, err = service.Resource(t.Context(), f.owner, f.project, f.task, snapshot.SessionID, resource)
	if httpx.ErrorKind(err) != "not_found" {
		t.Fatal("legacy resource route bypassed private refusal", err)
	}
}
