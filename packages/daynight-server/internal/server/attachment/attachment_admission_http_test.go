package attachment_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/appsupport"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

type admissionSafeLog struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (l *admissionSafeLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.data.Write(data)
}

func (l *admissionSafeLog) contains(value string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Contains(l.data.String(), value)
}

func admissionRequest(t *testing.T, client *http.Client, method, address, body string, headers map[string]string, status int) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, address, strings.NewReader(body))
	if err != nil {
		t.Fatal("could not create fixture request")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("fixture request failed")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != status {
		t.Fatalf("fixture response: status=%d want=%d read=%v close=%v", response.StatusCode, status, readErr, closeErr)
	}
	return response, data
}

func admissionDecode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal("fixture response was invalid JSON")
	}
	return value
}

func TestAttachmentHTTPAdmittedStreamSurvivesMemberRevocation(t *testing.T) {
	database := projectTestStore(t)
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configpkg.Config{DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0", StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second}
	config.PublicOrigin, config.UniAuthCallbackURL, config.UniAuthURL = origin, callback, gateway.Origin
	config.UniAuthAppID, config.UniAuthAppSecret = gateway.AppID, gateway.AppSecret
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logs := &admissionSafeLog{}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	handler, err := appsupport.NewHandler(config, database, database.Ready, files, logger)
	if err != nil {
		server.Close()
		t.Fatal(err)
	}
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	t.Cleanup(func() {
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if application, ok := handler.(interface{ Shutdown(context.Context) error }); ok {
			if err := application.Shutdown(ctx); err != nil {
				t.Error(err)
			}
		} else {
			t.Error("test server has no application shutdown")
		}
	})
	owner, member, bearerClient := testauth.Browser(t), testauth.Browser(t), testauth.Browser(t)
	owner.Timeout = 5 * time.Second
	testauth.Login(t, owner, origin, "alice")
	testauth.Login(t, member, origin, "bob")
	memberToken := testauth.CreatePAT(t, member, origin)
	_, body := admissionRequest(t, owner, http.MethodGet, origin+"/api/v1/me", "", nil, http.StatusOK)
	ownerUser := admissionDecode[api.User](t, body)
	_, body = admissionRequest(t, member, http.MethodGet, origin+"/api/v1/me", "", nil, http.StatusOK)
	memberUser := admissionDecode[api.User](t, body)
	if ownerUser.ID == memberUser.ID {
		t.Fatal("member and owner are not distinct")
	}
	originHeader := map[string]string{"Origin": origin}
	_, body = admissionRequest(t, owner, http.MethodPost, origin+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Stream admission", RepoURL: "https://example.test/stream", ExpectedUserID: ownerUser.ID}), originHeader, http.StatusCreated)
	project := admissionDecode[api.Project](t, body)
	base := "/api/v1/projects/" + project.ID
	_, body = admissionRequest(t, owner, http.MethodPost, origin+base+"/tasks", `{"title":"Streaming attachment"}`, originHeader, http.StatusCreated)
	task := admissionDecode[api.Task](t, body)
	_, body = admissionRequest(t, owner, http.MethodPost, origin+base+"/invitations", jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: ownerUser.ID}), originHeader, http.StatusCreated)
	invitation := admissionDecode[api.CreatedProjectInvitation](t, body)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("invitation omitted its token")
	}
	_, body = admissionRequest(t, member, http.MethodPost, origin+"/api/v1/invitations/accept", jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: memberUser.ID}), originHeader, http.StatusOK)
	joined := admissionDecode[api.ProjectInvitationAcceptance](t, body)
	if !joined.Joined || joined.Access.TeamRole != nil || joined.DirectGrant.UserID != memberUser.ID {
		t.Fatal("member did not receive a direct-only grant")
	}
	location := attachmentFilePath(task, "admission/complete.bin")
	prefix := bytes.Repeat([]byte{0, 0xff, 0x80, 'a'}, 4096)
	suffix := bytes.Repeat([]byte{'b', 0x01, '\n', 0xfe}, 4096)
	content := append(append([]byte{}, prefix...), suffix...)
	connection, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	type uploadResult struct {
		status int
		header http.Header
		body   []byte
		err    error
	}
	result := make(chan uploadResult, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
		if err != nil {
			result <- uploadResult{err: err}
			return
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		closeErr := response.Body.Close()
		if readErr == nil {
			readErr = closeErr
		}
		result <- uploadResult{status: response.StatusCode, header: response.Header, body: body, err: readErr}
	}()
	t.Cleanup(func() {
		_ = connection.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("stream response reader did not exit")
		}
	})
	const requestID = "admitted-upload"
	if _, err := fmt.Fprintf(connection, "PUT %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\nX-Request-ID: %s\r\nConnection: close\r\n\r\n", location, server.Listener.Addr(), memberToken, len(content), requestID); err != nil {
		t.Fatal("could not send upload headers")
	}
	if _, err := io.Copy(connection, bytes.NewReader(prefix)); err != nil {
		t.Fatal("could not send upload prefix")
	}
	staging := func() (int, int64, []byte) {
		t.Helper()
		count := 0
		var size int64
		var data []byte
		if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() && strings.HasPrefix(entry.Name(), ".daynight-upload-") {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				count++
				size += info.Size()
				if info.Size() == int64(len(prefix)) {
					data, err = os.ReadFile(path)
					return err
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return count, size, data
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		count, size, data := staging()
		if count == 1 && size == int64(len(prefix)) && bytes.Equal(data, prefix) {
			break
		}
		select {
		case got := <-result:
			t.Fatalf("upload ended before admission barrier: status=%d error=%v", got.status, got.err)
		case <-ctx.Done():
			t.Fatalf("upload prefix was not staged: count=%d size=%d", count, size)
		case <-ticker.C:
		}
	}
	finalPath := filepath.Join(root, "task-attachments", project.ID, task.ID[:2], task.ID, "admission", "complete.bin")
	if _, err := os.Stat(finalPath); !os.IsNotExist(err) {
		t.Fatalf("incomplete upload published a file: %v", err)
	}
	var grantCount, attachmentCount int
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2), (SELECT count(*) FROM task_attachments WHERE task_id=$3 AND path='admission/complete.bin')`, project.ID, memberUser.ID, task.ID).Scan(&grantCount, &attachmentCount); err != nil || grantCount != 1 || attachmentCount != 0 {
		t.Fatalf("unexpected state at admission: grant=%d attachment=%d error=%v", grantCount, attachmentCount, err)
	}
	revokeStarted := time.Now()
	admissionRequest(t, owner, http.MethodDelete, origin+base+"/members/"+memberUser.ID, jsonBody(t, api.RemoveProjectMemberRequest{Version: joined.DirectGrant.Version, ExpectedUserID: ownerUser.ID}), originHeader, http.StatusNoContent)
	if elapsed := time.Since(revokeStarted); elapsed >= 5*time.Second {
		t.Fatalf("grant revocation exceeded its bound: %s", elapsed)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, memberUser.ID).Scan(&grantCount); err != nil || grantCount != 0 {
		t.Fatalf("grant was not removed while streaming: count=%d error=%v", grantCount, err)
	}
	select {
	case got := <-result:
		t.Fatalf("upload completed before the remaining bytes: status=%d error=%v", got.status, got.err)
	default:
	}
	if count, size, data := staging(); count != 1 || size != int64(len(prefix)) || !bytes.Equal(data, prefix) {
		t.Fatalf("revocation changed incomplete upload: count=%d size=%d", count, size)
	}
	if _, err := io.Copy(connection, bytes.NewReader(suffix)); err != nil {
		t.Fatal("could not send upload suffix")
	}
	var completed uploadResult
	select {
	case completed = <-result:
	case <-ctx.Done():
		t.Fatal("admitted upload did not finish")
	}
	if completed.err != nil || completed.status != http.StatusCreated || completed.header.Get("Content-Type") != "application/json" || completed.header.Get("X-Request-ID") != requestID || completed.header.Get("Daynight-User-ID") != memberUser.ID {
		t.Fatalf("admitted upload response: status=%d error=%v", completed.status, completed.err)
	}
	metadata := admissionDecode[api.Attachment](t, completed.body)
	if metadata.Path != "admission/complete.bin" || metadata.SizeBytes != int64(len(content)) || metadata.ContentType != "application/octet-stream" {
		t.Fatalf("admitted upload metadata: %+v", metadata)
	}
	_, actual := admissionRequest(t, owner, http.MethodGet, origin+location, "", nil, http.StatusOK)
	if !bytes.Equal(actual, content) {
		t.Fatal("admitted upload did not preserve the complete bytes")
	}
	_, denial := admissionRequest(t, bearerClient, http.MethodGet, origin+location, "", map[string]string{"Authorization": "Bearer " + memberToken}, http.StatusNotFound)
	if admissionDecode[api.ErrorResponse](t, denial).Error.Code != "not_found" {
		t.Fatal("revoked member retained attachment access")
	}
	_, body = admissionRequest(t, owner, http.MethodGet, origin+taskPath(task), "", nil, http.StatusOK)
	if !reflect.DeepEqual(admissionDecode[api.Task](t, body), task) {
		t.Fatal("admitted upload changed its parent task")
	}
	if count, size, _ := staging(); count != 0 {
		t.Fatalf("completed upload left staging: count=%d size=%d", count, size)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE task_id=$1 AND path='admission/complete.bin'`, task.ID).Scan(&attachmentCount); err != nil || attachmentCount != 1 {
		t.Fatalf("completed upload metadata rows=%d error=%v", attachmentCount, err)
	}
	if logs.contains(memberToken) || logs.contains(link.Fragment) {
		t.Fatal("upload or authorization diagnostics exposed a credential")
	}
}
