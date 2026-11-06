package bot

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

func TestBotDeletionCleanupRechecksAuthorityAndPriorCompletion(t *testing.T) {
	bots, db, owner, workerID := botService(t)
	ctx := context.Background()
	credentialID := uuid.NewString()
	hash := sha256.Sum256([]byte(credentialID))
	if _, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'cleanup',now(),now()+interval '1 day')`, credentialID, owner.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: credentialID}
	created, err := bots.Create(ctx, principal, botInput(workerID))
	if err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	engine := sessioncore.NewEngine(files)
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := engine.Stop(stopCtx); err != nil {
			t.Error(err)
		}
	})
	sessions := sessionservice.New(db, engine)
	instructions := "Use Daynight CLI."
	roleHash := sha256.Sum256([]byte(instructions))
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	bound, err := sessions.RegisterBot(ctx, principal, workerID, created.ID, sessioncore.BotRegistration{BotVersion: created.Version, Registration: registration, Configuration: created.ResolvedConfiguration, RoleConfiguration: model.BotRoleConfiguration{Instructions: instructions, Revision: "1", Digest: fmt.Sprintf("%x", roleHash)}})
	if err != nil {
		t.Fatal(err)
	}
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, principal.UserID, bound.Session.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	orphan := namespace.Directory() + "/orphan.json"
	if _, err = files.Put(ctx, sessionarchive.Bucket, orphan, strings.NewReader("private")); err != nil {
		t.Fatal(err)
	}
	deletions := NewDeletions(db, files, engine)
	request := store.DeleteBot{Version: bound.Bot.Version, DeletionID: uuid.NewString()}
	_, err = deletions.clean(ctx, principal, created.ID, request.DeletionID)
	requireCleanupFault(t, err, "session_conflict")
	if _, err = deletions.DeleteBot(ctx, principal, created.ID, request); err != nil {
		t.Fatal(err)
	}
	_, err = deletions.clean(ctx, principal, created.ID, request.DeletionID)
	requireCleanupFault(t, err, "session_conflict")
	other := servicePrincipal(t, db)
	project, err := projectservice.NewProjects(db).Create(ctx, principal, projectcore.CreateProject{Name: "Session owner", RepoURL: "https://github.com/example/session-owner", ExpectedUserID: principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID); err != nil {
		t.Fatal(err)
	}
	_, err = deletions.clean(ctx, other, created.ID, request.DeletionID)
	requireCleanupFault(t, err, "forbidden")
	stop := sp.TestStop{Protocol: sp.Protocol, Fence: bound.Session.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	done, err := deletions.CompleteBotDeletion(ctx, principal, workerID, created.ID, BotDeletionReceipt{DeletionID: request.DeletionID, Stop: &stop, Result: model.BotCleanupResult{State: "completed"}})
	if err != nil {
		t.Fatal(err)
	}
	object, err := files.Open(ctx, sessionarchive.Bucket, orphan)
	if err == nil {
		_ = object.Body.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("bound Session archive remained after cleanup: %v", err)
	}
	replayed, err := deletions.clean(ctx, principal, created.ID, request.DeletionID)
	if err != nil || replayed.Version != done.Version || !replayed.UpdatedAt.Equal(done.UpdatedAt) {
		t.Fatalf("concurrent completion advanced the result: %+v %v", replayed, err)
	}
	_, err = deletions.clean(ctx, principal, created.ID, uuid.NewString())
	requireCleanupFault(t, err, "session_conflict")
}

func requireCleanupFault(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("wanted %s, got %v", code, err)
	}
}
