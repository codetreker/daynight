package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/jackc/pgx/v5"
)

type attachmentLockResponse struct {
	status int
	header http.Header
	body   []byte
	err    error
}

func attachmentLockRequest(client *http.Client, request *http.Request, result chan<- attachmentLockResponse, done chan<- struct{}) {
	defer close(done)
	response, err := client.Do(request)
	if err != nil {
		result <- attachmentLockResponse{err: err}
		return
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	closeErr := response.Body.Close()
	result <- attachmentLockResponse{status: response.StatusCode, header: response.Header.Clone(), body: body, err: errors.Join(readErr, closeErr)}
}

func awaitAttachmentLockResponse(t *testing.T, ctx context.Context, result <-chan attachmentLockResponse) attachmentLockResponse {
	t.Helper()
	select {
	case response := <-result:
		if response.err != nil {
			t.Fatalf("attachment race HTTP request failed: %v", response.err)
		}
		return response
	case <-ctx.Done():
		t.Fatal("attachment race HTTP request did not complete within its deadline")
		return attachmentLockResponse{}
	}
}

func TestAttachmentUploadAndProjectGrantRemovalSerialize(t *testing.T) {
	integration := newIdentityIntegration(t)
	admin, member := identityBrowser(t), identityBrowser(t)
	adminUser := integration.login(t, admin, "alice")
	memberUser := integration.login(t, member, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	_, data := identityRequest(t, admin, http.MethodPost, integration.server.URL+"/api/v1/projects",
		jsonBody(t, api.CreateProjectRequest{Name: "Attachment grant lock", RepoURL: "https://example.com/attachment-grant", ExpectedUserID: adminUser.ID}), origin, http.StatusCreated)
	project := identityDecode[api.Project](t, data)
	base := "/api/v1/projects/" + project.ID
	_, data = identityRequest(t, admin, http.MethodPost, integration.server.URL+base+"/invitations", invitationActorBody(adminUser.ID), origin, http.StatusCreated)
	invitation := identityDecode[api.CreatedProjectInvitation](t, data)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("project invitation did not contain its acceptance token")
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/invitations/accept", invitationAcceptBody(link.Fragment, memberUser.ID), origin, http.StatusOK)
	accepted := identityDecode[api.ProjectInvitationAcceptance](t, data)
	if accepted.DirectGrant.UserID != memberUser.ID || accepted.DirectGrant.ProjectID != project.ID {
		t.Fatal("member did not receive the intended direct grant")
	}
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+base+"/tasks", `{"title":"Attachment lock"}`, origin, http.StatusCreated)
	task := identityDecode[api.Task](t, data)
	_, data = identityRequest(t, member, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Attachment lock","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	integration.secrets = append(integration.secrets, token.Token)

	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	client := &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone(), Timeout: 12 * time.Second}
	defer client.CloseIdleConnections()
	reader, writer := io.Pipe()
	defer writer.CloseWithError(context.Canceled)
	const prefixSize = 64 << 10
	body := bytes.Repeat([]byte{0, 0xff, 0x7f, '\n'}, 256<<10)
	path := attachmentFilePath(task, "lock/retained.bin")
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, integration.server.URL+path, reader)
	if err != nil {
		t.Fatal("cannot construct held upload")
	}
	request.ContentLength = int64(len(body))
	request.Header.Set("Authorization", "Bearer "+token.Token)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Request-ID", "attachment-grant-lock")
	uploadResult, uploadDone := make(chan attachmentLockResponse, 1), make(chan struct{})
	go attachmentLockRequest(client, request, uploadResult, uploadDone)
	var removalDone <-chan struct{}
	defer func() {
		cancel()
		_ = writer.CloseWithError(context.Canceled)
		for _, done := range []<-chan struct{}{uploadDone, removalDone} {
			if done == nil {
				continue
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("owned attachment race request did not stop")
			}
		}
	}()
	if n, err := writer.Write(body[:prefixSize]); err != nil || n != prefixSize {
		t.Fatalf("cannot send complete upload prefix: %d %v", n, err)
	}

	staging := filepath.Join(integration.storageRoot, "task-attachments", project.ID, task.ID[:2], task.ID, "lock")
	wait := func(label string, check func() (bool, error)) {
		t.Helper()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			ok, err := check()
			if err != nil {
				t.Fatalf("%s observation failed: %v", label, err)
			}
			if ok {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("%s was not observed within the deadline", label)
			case <-ticker.C:
			}
		}
	}
	wait("held upload prefix", func() (bool, error) {
		entries, err := os.ReadDir(staging)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".daynight-upload-") {
				contents, err := os.ReadFile(filepath.Join(staging, entry.Name()))
				return err == nil && bytes.Equal(contents, body[:prefixSize]), err
			}
		}
		return false, nil
	})

	removeBody := jsonBody(t, map[string]any{"version": accepted.DirectGrant.Version, "expectedUserId": adminUser.ID})
	removeRequest, err := http.NewRequestWithContext(ctx, http.MethodDelete, integration.server.URL+base+"/members/"+memberUser.ID, strings.NewReader(removeBody))
	if err != nil {
		t.Fatal("cannot construct grant removal")
	}
	removeRequest.Header.Set("Origin", integration.server.URL)
	removeRequest.Header.Set("Content-Type", "application/json")
	removalResult, done := make(chan attachmentLockResponse, 1), make(chan struct{})
	removalDone = done
	go attachmentLockRequest(admin, removeRequest, removalResult, done)

	var waiter, blocker int32
	wait("grant row lock wait", func() (bool, error) {
		err := integration.database.QueryRow(ctx, `SELECT waiting.pid, blocking.pid
			FROM pg_stat_activity waiting
			JOIN pg_locks tuple_lock ON tuple_lock.pid=waiting.pid AND tuple_lock.locktype='tuple'
				AND tuple_lock.relation='project_grants'::regclass
			JOIN project_grants grant_row ON grant_row.ctid=format('(%s,%s)',tuple_lock.page,tuple_lock.tuple)::tid
			CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) blocked_by(pid)
			JOIN pg_stat_activity blocking ON blocking.pid=blocked_by.pid
			WHERE waiting.application_name=current_setting('application_name') AND waiting.wait_event_type='Lock'
				AND waiting.query LIKE 'DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2%'
				AND grant_row.project_id=$1 AND grant_row.user_id=$2
				AND blocking.application_name=current_setting('application_name') AND blocking.state='idle in transaction'
				AND blocking.query LIKE '%FROM task_attachments%'`, project.ID, memberUser.ID).Scan(&waiter, &blocker)
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return err == nil && waiter > 0 && blocker > 0 && waiter != blocker, err
	})
	select {
	case <-uploadDone:
		t.Fatal("upload completed before the remainder was sent")
	case <-removalDone:
		t.Fatal("grant removal completed while the upload held its authorization lock")
	default:
	}
	var grants, metadata int
	if err := integration.database.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2),
		(SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$3 AND path=$4)`, project.ID, memberUser.ID, task.ID, "lock/retained.bin").Scan(&grants, &metadata); err != nil || grants != 1 || metadata != 0 {
		t.Fatalf("held upload or grant changed before release: grants=%d metadata=%d error=%v", grants, metadata, err)
	}
	if n, err := writer.Write(body[prefixSize:]); err != nil || n != len(body)-prefixSize {
		t.Fatalf("cannot send remaining upload: %d %v", n, err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal("cannot finish held upload")
	}
	uploaded := awaitAttachmentLockResponse(t, ctx, uploadResult)
	if uploaded.status != http.StatusCreated || uploaded.header.Get("X-Request-ID") != "attachment-grant-lock" {
		t.Fatalf("admitted upload returned HTTP %d or lost request correlation", uploaded.status)
	}
	attachment := identityDecode[api.Attachment](t, uploaded.body)
	if attachment.Path != "lock/retained.bin" || attachment.SizeBytes != int64(len(body)) {
		t.Fatalf("upload receipt differs from the sent bytes: %+v", attachment)
	}
	removed := awaitAttachmentLockResponse(t, ctx, removalResult)
	if removed.status != http.StatusNoContent || len(removed.body) != 0 {
		t.Fatalf("grant removal returned HTTP %d", removed.status)
	}
	_, stored := identityRequest(t, admin, http.MethodGet, integration.server.URL+path, "", nil, http.StatusOK)
	if !bytes.Equal(stored, body) {
		t.Fatal("committed attachment bytes differ from the upload")
	}
	_, denial := identityRequest(t, member, http.MethodGet, integration.server.URL+path, "", nil, http.StatusNotFound)
	if identityDecode[api.ErrorResponse](t, denial).Error.Code != "not_found" {
		t.Fatal("revoked member did not receive the expected refusal")
	}
	_, patDenial := identityRequest(t, client, http.MethodGet, integration.server.URL+path, "", map[string]string{"Authorization": "Bearer " + token.Token}, http.StatusNotFound)
	if identityDecode[api.ErrorResponse](t, patDenial).Error.Code != "not_found" {
		t.Fatal("the upload PAT retained access after grant removal")
	}
	if err := integration.database.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2),
		(SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$3 AND path=$4)`, project.ID, memberUser.ID, task.ID, "lock/retained.bin").Scan(&grants, &metadata); err != nil || grants != 0 || metadata != 1 {
		t.Fatalf("committed grant or attachment metadata differs: grants=%d metadata=%d error=%v", grants, metadata, err)
	}
	entries, err := os.ReadDir(staging)
	if err != nil {
		t.Fatal("cannot inspect attachment staging cleanup")
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".daynight-upload-") {
			t.Fatal("completed upload left a temporary file")
		}
	}
	t.Logf("grant lock wait: waiter=%d blocker=%d; upload=201 removal=204 member=404; bytes=%d", waiter, blocker, len(body))
}
