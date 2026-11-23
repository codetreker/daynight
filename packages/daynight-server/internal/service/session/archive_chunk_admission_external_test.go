package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type archiveBarrier struct {
	filestorage.Storage
	enabled          atomic.Bool
	entered, release chan struct{}
	once             sync.Once
}

func (s *archiveBarrier) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	if s.enabled.Load() {
		s.once.Do(func() { close(s.entered) })
		select {
		case <-s.release:
		case <-ctx.Done():
			return filestorage.FileInfo{}, ctx.Err()
		}
	}
	return s.Storage.Put(ctx, bucket, path, body)
}

type archiveCount struct {
	filestorage.Storage
	writes atomic.Int32
}

func (s *archiveCount) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	s.writes.Add(1)
	return s.Storage.Put(ctx, bucket, path, body)
}

func archiveFixture(t *testing.T) (*postgres.Store, model.Principal, string, string, sp.Registration) {
	t.Helper()
	ctx := context.Background()
	db, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user := testsupport.ServicePrincipal(t, db)
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	if _, err = db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(business_scopes,scope_version,id,user_id,token_hash,name,created_at,expires_at) VALUES(ARRAY['session:control','session:produce','session:read','session:send'],1,$1,$2,$3,'archive test',now(),now()+interval '1 day')`, pat, user.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	owner := model.Principal{Kind: model.PATCredential, UserID: user.UserID, CredentialID: pat}
	project, task := uuid.NewString(), uuid.NewString()
	reg := sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	props, err := taskprops.WithWorker(model.TaskProperties{}, &model.WorkerClaim{ClaimID: reg.ClaimID, UserID: owner.UserID, WorkerID: reg.WorkerID, WorktreeID: reg.WorktreeID, State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test"}, Platform: model.PlatformLinux, Phase: model.WorkerExecuting, ClaimedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Session test','https://github.com/example/session.git')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id,version,updated_at) SELECT $1,id,1,now() FROM teams WHERE personal_user_id=$2`, []any{project, owner.UserID}},
		{`INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Session test','in_progress')`, []any{task, project}},
		{`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, []any{task, string(props["worker"])}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return db, owner, project, task, reg
}

// A real HTTP request must not overwrite an admitted chunk between the first
// transaction and its storage write, even on a different server instance.
func TestArchiveChunkAdmissionPreventsConcurrentOffsetOverwrite(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, owner, project, task, reg := archiveFixture(t)
	root := t.TempDir()
	firstFiles, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer firstFiles.Close()
	secondFiles, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer secondFiles.Close()
	barrier := &archiveBarrier{Storage: firstFiles, entered: make(chan struct{}), release: make(chan struct{})}
	counted := &archiveCount{Storage: secondFiles}
	firstEngine, secondEngine := core.NewEngine(barrier), core.NewEngine(counted)
	defer firstEngine.Stop(context.Background())
	defer secondEngine.Stop(context.Background())
	first, second := sessionservice.New(db, firstEngine), sessionservice.New(db, secondEngine)
	v, err := first.Register(ctx, owner, project, task, reg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, task); err != nil {
		t.Fatal(err)
	}
	setup, err := first.BeginArchive(ctx, owner, project, task, v.SessionID, core.ArchiveV1Upload)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := setup.PrepareArchive(ctx, sp.ArchivePrepareRequest{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID})
	if err != nil {
		t.Fatal(err)
	}
	history, err := json.Marshal(sp.ArchiveHistoryContent{HistoryEpoch: prepared.HistoryEpoch, SourceThrough: prepared.SourceThrough, Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
	if err != nil {
		t.Fatal(err)
	}
	hash := func(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
	if _, err = setup.PutArchiveFile(ctx, "history", uuid.NewString(), 0, int64(len(history)), hash(history), hash(history), history); err != nil {
		t.Fatal(err)
	}
	if _, err = setup.SealArchive(ctx); err != nil {
		t.Fatal(err)
	}
	if err = setup.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{}})
	if err != nil {
		t.Fatal(err)
	}
	fileID := uuid.NewString()
	digest := hash(data)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != model.PATCredential || token != "test-token" {
			return model.Principal{}, authhttp.Failure()
		}
		return owner, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	startServer := func(service *sessionservice.Service) *httptest.Server {
		routes := sessionhttp.NewRoutes(service, &authhttp.Authentication{RequestAuthentication: auth}, logger)
		mux := http.NewServeMux()
		routes.RegisterRoutes(mux)
		server := httptest.NewServer(mux)
		t.Cleanup(server.Close)
		return server
	}
	firstServer, secondServer := startServer(first), startServer(second)
	request := func(server *httptest.Server, content []byte) (*http.Request, error) {
		url := fmt.Sprintf("%s/api/v1/projects/%s/tasks/%s/sessions/%s/archive/files/%s?offset=0", server.URL, project, task, v.SessionID, fileID)
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(content))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer test-token")
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Daynight-File-Byte-Length", strconv.Itoa(len(content)))
		req.Header.Set("Daynight-File-SHA256", hash(content))
		req.Header.Set("Daynight-Chunk-SHA256", hash(content))
		return req, nil
	}
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 1)
	firstRequest, err := request(firstServer, data)
	if err != nil {
		t.Fatal(err)
	}
	barrier.enabled.Store(true)
	go func() {
		response, e := firstServer.Client().Do(firstRequest)
		if e != nil {
			results <- result{err: e}
			return
		}
		body, e := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if e == nil {
			e = closeErr
		}
		results <- result{response.StatusCode, body, e}
	}()
	released := false
	defer func() {
		if !released {
			close(barrier.release)
		}
	}()
	select {
	case <-barrier.entered:
	case r := <-results:
		t.Fatalf("first HTTP request did not reach storage: %d %s %v", r.status, r.body, r.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var offset int64
	if err = db.Pool.QueryRow(ctx, `SELECT accepted_offset FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, v.SessionID, fileID).Scan(&offset); err != nil || offset != 0 {
		t.Fatalf("initial file check: offset %d %v", offset, err)
	}
	other := append([]byte(nil), data...)
	other[len(other)-1] ^= 1
	req, err := request(secondServer, other)
	if err != nil {
		t.Fatal(err)
	}
	response, err := secondServer.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if readErr != nil || response.StatusCode != http.StatusTooManyRequests || !strings.Contains(string(body), `"resource_busy"`) {
		t.Fatalf("competing HTTP response %d %s %v", response.StatusCode, body, readErr)
	}
	if counted.writes.Load() != 0 {
		t.Fatal("competing request wrote storage before rejection")
	}
	close(barrier.release)
	released = true
	r := <-results
	var receipt sp.ArchiveFileReceipt
	decodeErr := json.Unmarshal(r.body, &receipt)
	if r.err != nil || r.status != http.StatusOK || decodeErr != nil || receipt.SHA256 != digest || receipt.AcceptedOffset != strconv.Itoa(len(data)) || receipt.State != "complete" {
		t.Fatalf("first HTTP receipt: status %d body %s parsed %+v error %v decode %v", r.status, r.body, receipt, r.err, decodeErr)
	}
	var path string
	if err = db.Pool.QueryRow(ctx, `SELECT object_path FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, v.SessionID, fileID).Scan(&path); err != nil {
		t.Fatal(err)
	}
	object, err := firstFiles.Open(ctx, sessionarchive.Bucket, path+"/content")
	if err != nil {
		t.Fatal(err)
	}
	stored, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || !bytes.Equal(stored, data) {
		t.Fatalf("stored bytes do not match receipt: %v %v", readErr, closeErr)
	}
}
