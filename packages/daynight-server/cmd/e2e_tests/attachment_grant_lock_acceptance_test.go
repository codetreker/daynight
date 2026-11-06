package e2e_tests

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5"
)

type acceptanceGrantLockEvidence struct {
	ProjectID     string `json:"projectId"`
	UserID        string `json:"userId"`
	TaskID        string `json:"taskId"`
	WaiterPID     int32  `json:"waiterPid"`
	BlockerPID    int32  `json:"blockerPid"`
	PrefixBytes   int    `json:"prefixBytes"`
	Bytes         int    `json:"bytes"`
	SHA256        string `json:"sha256"`
	UploadStatus  int    `json:"uploadStatus"`
	RemovalStatus int    `json:"removalStatus"`
	MemberStatus  int    `json:"memberStatus"`
	PATStatus     int    `json:"patStatus"`
}

func acceptanceGrantHTTP(client *http.Client, request *http.Request, result chan<- acceptanceResponse, done chan<- struct{}) {
	defer close(done)
	response, err := client.Do(request)
	if err != nil {
		result <- acceptanceResponse{err: err}
		return
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	closeErr := response.Body.Close()
	result <- acceptanceResponse{status: response.StatusCode, header: response.Header.Clone(), body: body, err: errors.Join(readErr, closeErr)}
}

func acceptanceGrantResult(t *testing.T, ctx context.Context, result <-chan acceptanceResponse) acceptanceResponse {
	t.Helper()
	select {
	case response := <-result:
		if response.err != nil {
			t.Fatal("owned grant race HTTP request failed")
		}
		return response
	case <-ctx.Done():
		t.Fatal("owned grant race HTTP request exceeded its deadline")
		return acceptanceResponse{}
	}
}

func acceptanceGrantMemberRequest(ctx context.Context, origin, token, method, path string, input any) acceptanceResponse {
	var body io.Reader
	if input != nil {
		value, err := json.Marshal(input)
		if err != nil {
			return acceptanceResponse{err: err}
		}
		body = bytes.NewReader(value)
	}
	request, err := http.NewRequestWithContext(ctx, method, origin+path, body)
	if err != nil {
		return acceptanceResponse{err: err}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	result, done := make(chan acceptanceResponse, 1), make(chan struct{})
	acceptanceGrantHTTP(&http.Client{Transport: transport, Timeout: 8 * time.Second}, request, result, done)
	return <-result
}

func TestAttachmentGrantLockAcceptance(t *testing.T) {
	acceptanceCase(t, "attachment_upload_grant_lock", []string{"AU-V6", "FA7", "FA11"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		adminID := process.expectedUserID(t)
		project := process.project(t, "Attachment grant lock")
		task := process.task(t, project, "Attachment lock")
		member := testauth.Browser(t)
		testauth.Login(t, member, process.origin, "bob")
		response, err := member.Get(process.origin + "/api/v1/me")
		if err != nil {
			t.Fatal("cannot read authenticated member")
		}
		var memberUser api.User
		decodeErr := json.NewDecoder(response.Body).Decode(&memberUser)
		closeErr := response.Body.Close()
		if response.StatusCode != http.StatusOK || decodeErr != nil || closeErr != nil || memberUser.ID == "" || memberUser.ID == adminID {
			t.Fatal("member identity was not distinct and authenticated")
		}
		memberToken := testauth.CreatePAT(t, member, process.origin)
		member.CloseIdleConnections()
		invitation := acceptanceDecode[api.CreatedProjectInvitation](t, process.request(t.Context(), http.MethodPost, "/api/v1/projects/"+project.ID+"/invitations", api.ProjectInvitationMutationRequest{ExpectedUserID: adminID}, "grant-lock-invitation"), http.StatusCreated)
		link, err := url.Parse(invitation.Link)
		if err != nil || link.Fragment == "" {
			t.Fatal("invitation omitted its acceptance token")
		}
		joined := acceptanceDecode[api.ProjectInvitationAcceptance](t, acceptanceGrantMemberRequest(t.Context(), process.origin, memberToken, http.MethodPost, "/api/v1/invitations/accept", api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: memberUser.ID}), http.StatusOK)
		if joined.DirectGrant.UserID != memberUser.ID || joined.DirectGrant.ProjectID != project.ID {
			t.Fatal("member did not receive the intended direct grant")
		}

		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		defer cancel()
		client := &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone(), Timeout: 12 * time.Second}
		defer client.CloseIdleConnections()
		reader, writer := io.Pipe()
		defer writer.CloseWithError(context.Canceled)
		const prefixSize = 64 << 10
		body := bytes.Repeat([]byte{0, 0xff, 0x7f, '\n'}, 256<<10)
		path := acceptanceAttachmentPath(task, "lock/retained.bin")
		request, err := http.NewRequestWithContext(ctx, http.MethodPut, process.origin+path, reader)
		if err != nil {
			t.Fatal("cannot construct held upload")
		}
		request.ContentLength = int64(len(body))
		request.Header.Set("Authorization", "Bearer "+memberToken)
		request.Header.Set("Content-Type", "application/octet-stream")
		request.Header.Set("X-Request-ID", "attachment-grant-lock")
		uploadResult, uploadDone := make(chan acceptanceResponse, 1), make(chan struct{})
		go acceptanceGrantHTTP(client, request, uploadResult, uploadDone)
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
					t.Error("owned grant race request did not stop")
				}
			}
		}()
		if n, err := writer.Write(body[:prefixSize]); err != nil || n != prefixSize {
			t.Fatalf("cannot send upload prefix: %d", n)
		}
		staging := filepath.Join(fixture.storageRoot, "task-attachments", project.ID, task.ID[:2], task.ID, "lock")
		if err := acceptanceEventually(ctx, func() (bool, error) {
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
		}); err != nil {
			t.Fatal("held upload prefix was not observed on disk")
		}

		removeResult, done := make(chan acceptanceResponse, 1), make(chan struct{})
		removalDone = done
		go func() {
			defer close(done)
			removeResult <- process.request(ctx, http.MethodDelete, "/api/v1/projects/"+project.ID+"/members/"+memberUser.ID,
				map[string]any{"version": joined.DirectGrant.Version, "expectedUserId": adminID}, "grant-lock-removal")
		}()
		var waiter, blocker int32
		if err := acceptanceEventually(ctx, func() (bool, error) {
			err := fixture.admin.QueryRow(ctx, `SELECT waiting.pid, blocking.pid
				FROM pg_stat_activity waiting
				JOIN pg_locks tuple_lock ON tuple_lock.pid=waiting.pid AND tuple_lock.locktype='tuple'
					AND tuple_lock.relation='project_grants'::regclass
				JOIN project_grants grant_row ON grant_row.ctid=format('(%s,%s)',tuple_lock.page,tuple_lock.tuple)::tid
				CROSS JOIN LATERAL unnest(pg_blocking_pids(waiting.pid)) blocked_by(pid)
				JOIN pg_stat_activity blocking ON blocking.pid=blocked_by.pid
				WHERE waiting.application_name=$3 AND waiting.wait_event_type='Lock'
					AND waiting.query LIKE 'DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2%'
					AND grant_row.project_id=$1 AND grant_row.user_id=$2
					AND blocking.application_name=$3 AND blocking.state='idle in transaction'
					AND blocking.query LIKE '%FROM task_attachments%'`, project.ID, memberUser.ID, process.application).Scan(&waiter, &blocker)
			if errors.Is(err, pgx.ErrNoRows) {
				return false, nil
			}
			return err == nil && waiter > 0 && blocker > 0 && waiter != blocker, err
		}); err != nil {
			t.Fatal("exact grant lock wait was not observed")
		}
		select {
		case <-uploadDone:
			t.Fatal("upload completed before the remainder was sent")
		case <-removalDone:
			t.Fatal("grant removal completed while upload held authorization")
		default:
		}
		var grants, metadata int
		if err := fixture.admin.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2),
			(SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$3 AND path=$4)`, project.ID, memberUser.ID, task.ID, "lock/retained.bin").Scan(&grants, &metadata); err != nil || grants != 1 || metadata != 0 {
			t.Fatal("held upload or grant changed before release")
		}
		if n, err := writer.Write(body[prefixSize:]); err != nil || n != len(body)-prefixSize {
			t.Fatalf("cannot send remaining upload: %d", n)
		}
		if err := writer.Close(); err != nil {
			t.Fatal("cannot finish held upload")
		}
		uploaded := acceptanceGrantResult(t, ctx, uploadResult)
		attachment := acceptanceDecode[api.Attachment](t, uploaded, http.StatusCreated)
		if uploaded.header.Get("X-Request-ID") != "attachment-grant-lock" || attachment.Path != "lock/retained.bin" || attachment.SizeBytes != int64(len(body)) {
			t.Fatal("upload receipt differs from the sent bytes")
		}
		removed := acceptanceGrantResult(t, ctx, removeResult)
		if removed.status != http.StatusNoContent || len(removed.body) != 0 {
			t.Fatal("grant removal did not return 204")
		}
		stored := process.attachmentRequest(http.MethodGet, path, "", nil)
		if stored.err != nil || stored.status != http.StatusOK || !bytes.Equal(stored.body, body) {
			t.Fatal("committed attachment bytes differ from upload")
		}
		denied := acceptanceGrantMemberRequest(ctx, process.origin, memberToken, http.MethodGet, path, nil)
		acceptanceError(t, denied, http.StatusNotFound, "not_found")
		memberResponse, err := member.Get(process.origin + path)
		if err != nil {
			t.Fatal("cannot read revoked member resource")
		}
		memberBody, readErr := io.ReadAll(io.LimitReader(memberResponse.Body, 1<<20))
		closeErr = memberResponse.Body.Close()
		if readErr != nil || closeErr != nil || memberResponse.StatusCode != http.StatusNotFound {
			t.Fatal("revoked member cookie did not receive 404")
		}
		var memberError api.ErrorResponse
		if json.Unmarshal(memberBody, &memberError) != nil || memberError.Error.Code != "not_found" {
			t.Fatal("revoked member cookie did not receive not_found")
		}
		if err := fixture.admin.QueryRow(ctx, `SELECT
			(SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2),
			(SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$3 AND path=$4)`, project.ID, memberUser.ID, task.ID, "lock/retained.bin").Scan(&grants, &metadata); err != nil || grants != 0 || metadata != 1 {
			t.Fatal("committed grant or attachment metadata differs")
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
		if err := binaryAcceptance.update(func() {
			scenario.GrantLock = &acceptanceGrantLockEvidence{ProjectID: project.ID, UserID: memberUser.ID, TaskID: task.ID, WaiterPID: waiter, BlockerPID: blocker, PrefixBytes: prefixSize, Bytes: len(body), SHA256: fmtHash(body), UploadStatus: uploaded.status, RemovalStatus: removed.status, MemberStatus: memberResponse.StatusCode, PATStatus: denied.status}
		}); err != nil {
			t.Fatal("cannot persist grant lock evidence")
		}
	})
}

func fmtHash(value []byte) string { sum := sha256.Sum256(value); return fmt.Sprintf("%x", sum) }
