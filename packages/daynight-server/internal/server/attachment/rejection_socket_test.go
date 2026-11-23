package attachment_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

type rejectionBodyObservation struct{ before, after, closeErr error }
type rejectionObservedBody struct {
	io.ReadCloser
	ctx          context.Context
	observations chan<- rejectionBodyObservation
}

func (b *rejectionObservedBody) Close() error {
	before := b.ctx.Err()
	err := b.ReadCloser.Close()
	b.observations <- rejectionBodyObservation{before, b.ctx.Err(), err}
	return err
}

func TestAttachmentConflictResponseWithUnreadBody(t *testing.T) {
	for _, tc := range []struct{ name, framing, initial string }{
		{"complete", "Content-Length: 3\r\n", "abc"},
		{"segmented", "Content-Length: 100\r\n", "ab"},
		{"delayed", "Content-Length: 100\r\n", ""},
		{"unfinished chunked", "Transfer-Encoding: chunked\r\n", "3\r\nabc\r\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString()}
			principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			token := "dnpat_" + strings.Repeat("A", 43)
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
				if ctx.Err() != nil || kind != model.PATCredential || credential != token {
					t.Error("unexpected authentication")
					return model.Principal{}, errors.New("unexpected authentication")
				}
				return principal, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
			if err != nil {
				t.Fatal(err)
			}
			entered := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(release) })
			closed := make(chan rejectionBodyObservation, 1)
			ops := attachmenthttp.AttachmentOperationsForTest{PutRetained: func(ctx context.Context, p model.Principal, project, id, path, contentType string, content io.Reader) (model.Attachment, bool, io.Closer, error) {
				if ctx.Err() != nil || p != principal || project != task.ProjectID || id != task.ID || path != "parent/child" {
					t.Error("unexpected upload arguments")
				}
				close(entered)
				<-release
				return model.Attachment{}, false, nil, &model.Fault{Code: "path_conflict", Message: "Attachment path conflicts with a file or directory."}
			}}
			mux := http.NewServeMux()
			attachmenthttp.RegisterRoutesWithOperationsForTest(mux, ops, auth.Require, logger, time.Second)
			handler := httpx.RequestLogging(logger, attachmenthttp.PathGuard(mux, logger))
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.Body = &rejectionObservedBody{ReadCloser: r.Body, ctx: r.Context(), observations: closed}
				handler.ServeHTTP(w, r)
			}))
			t.Cleanup(server.Close)
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nX-Request-ID: path-conflict-socket\r\nContent-Type: text/plain\r\n%s\r\n", attachmentFilePath(task, "parent/child"), token, tc.framing)
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("upload did not enter")
			}
			if tc.initial != "" {
				if _, err := fmt.Fprint(conn, tc.initial); err != nil {
					t.Fatal(err)
				}
			}
			if tc.name == "segmented" {
				if _, err := fmt.Fprint(conn, "cd"); err != nil {
					t.Fatal(err)
				}
			}
			releaseOnce.Do(func() { close(release) })
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if readErr != nil || response.StatusCode != http.StatusConflict || !response.Close || !strings.Contains(string(data), `"code":"path_conflict"`) || !strings.Contains(string(data), `"requestId":"path-conflict-socket"`) || response.Header.Get("X-Request-ID") != "path-conflict-socket" {
				t.Fatalf("status=%s close=%v body=%q read=%v", response.Status, response.Close, data, readErr)
			}
			select {
			case observation := <-closed:
				if observation.before != nil {
					t.Fatalf("request canceled before cleanup: %v", observation.before)
				}
				if tc.name != "complete" {
					var timeout net.Error
					if !errors.Is(observation.after, context.Canceled) || !errors.As(observation.closeErr, &timeout) || !timeout.Timeout() {
						t.Fatalf("unfinished body did not cancel during close: %+v", observation)
					}
				}
			case <-time.After(5 * time.Second):
				t.Fatal("body did not close")
			}
			if _, err := reader.ReadByte(); err != io.EOF {
				t.Fatalf("rejected connection remained open: %v", err)
			}
		})
	}
}

type failedRejectionWriter struct {
	http.ResponseWriter
	phase string
}

func (w *failedRejectionWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *failedRejectionWriter) SetWriteDeadline(deadline time.Time) error {
	if w.phase == "deadline" {
		return errors.New("private deadline failure")
	}
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}
func (w *failedRejectionWriter) FlushError() error {
	if w.phase == "flush" {
		return errors.New("private flush failure")
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}

func TestAttachmentRejectionTransportFailureAborts(t *testing.T) {
	for _, phase := range []string{"deadline", "flush"} {
		t.Run(phase, func(t *testing.T) {
			task := api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString()}
			principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			token := "dnpat_" + strings.Repeat("A", 43)
			logs := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var output strings.Builder
				logger := slog.New(slog.NewJSONHandler(&output, nil))
				defer func() { logs <- output.String() }()
				auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) { return principal, nil }, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
				if err != nil {
					t.Error(err)
					return
				}
				ops := attachmenthttp.AttachmentOperationsForTest{PutRetained: func(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error) {
					return model.Attachment{}, false, nil, &model.Fault{Code: "path_conflict", Message: "conflict"}
				}}
				mux := http.NewServeMux()
				attachmenthttp.RegisterRoutesWithOperationsForTest(mux, ops, auth.Require, logger, time.Second)
				httpx.RequestLogging(logger, attachmenthttp.PathGuard(mux, logger)).ServeHTTP(&failedRejectionWriter{ResponseWriter: w, phase: phase}, r)
			}))
			t.Cleanup(server.Close)
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nX-Request-ID: rejection-failure\r\nContent-Length: 100\r\n\r\n", attachmentFilePath(task, "parent/child"), token)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if response != nil || err != io.ErrUnexpectedEOF {
				t.Fatalf("failed %s emitted response=%v error=%v", phase, response, err)
			}
			select {
			case output := <-logs:
				if !strings.Contains(output, `"request_id":"rejection-failure"`) || !strings.Contains(output, `"phase":"rejection `) || strings.Contains(output, "private ") || strings.Contains(output, `"status":200`) {
					t.Fatalf("failure logs: %s", output)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("failed response did not finish")
			}
		})
	}
}

func TestAttachmentConflictAfterClientDisconnectAborts(t *testing.T) {
	task := api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString()}
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	token := "dnpat_" + strings.Repeat("A", 43)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) { return principal, nil }, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	result := make(chan error, 1)
	ops := attachmenthttp.AttachmentOperationsForTest{PutRetained: func(ctx context.Context, _ model.Principal, _, _, _, _ string, body io.Reader) (model.Attachment, bool, io.Closer, error) {
		close(entered)
		_, readErr := io.ReadAll(body)
		if readErr == nil || !errors.Is(ctx.Err(), context.Canceled) {
			result <- fmt.Errorf("read=%v context=%v", readErr, ctx.Err())
		} else {
			result <- nil
		}
		return model.Attachment{}, false, nil, &model.Fault{Code: "path_conflict", Message: "conflict"}
	}}
	mux := http.NewServeMux()
	attachmenthttp.RegisterRoutesWithOperationsForTest(mux, ops, auth.Require, logger, time.Second)
	server := httptest.NewServer(httpx.RequestLogging(logger, attachmenthttp.PathGuard(mux, logger)))
	t.Cleanup(server.Close)
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Length: 100\r\n\r\na", attachmentFilePath(task, "parent/child"), token)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not enter")
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("disconnect did not cancel upload")
	}
}

type reusableRejectionWriter struct {
	http.ResponseWriter
	failClear bool
	deadlines chan<- time.Time
}

func (w *reusableRejectionWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *reusableRejectionWriter) SetWriteDeadline(deadline time.Time) error {
	var err error
	if deadline.IsZero() && w.failClear {
		err = errors.New("private deadline restoration failure")
	} else {
		err = http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
	}
	w.deadlines <- deadline
	return err
}

func TestAttachmentConsumedConflictResponseRestoresWriteDeadline(t *testing.T) {
	for _, failClear := range []bool{false, true} {
		name := "reusable"
		if failClear {
			name = "restore fails"
		}
		t.Run(name, func(t *testing.T) {
			task := api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString()}
			principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			token := "dnpat_" + strings.Repeat("A", 43)
			logs := make(chan string, 2)
			deadlines := make(chan time.Time, 2)
			var uploads, lists atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var output strings.Builder
				logger := slog.New(slog.NewJSONHandler(&output, nil))
				defer func() { logs <- output.String() }()
				auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
					if ctx.Err() != nil || kind != model.PATCredential || credential != token {
						return model.Principal{}, errors.New("unexpected authentication")
					}
					return principal, nil
				}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
				if err != nil {
					t.Error(err)
					return
				}
				ops := attachmenthttp.AttachmentOperationsForTest{
					PutRetained: func(ctx context.Context, p model.Principal, project, id, path, contentType string, body io.Reader) (model.Attachment, bool, io.Closer, error) {
						if uploads.Add(1) != 1 {
							t.Error("unexpected repeated upload")
						}
						data, err := io.ReadAll(body)
						if err != nil || string(data) != "abc" || ctx.Err() != nil || p != principal || project != task.ProjectID || id != task.ID || path != "parent/child" {
							t.Errorf("unexpected consumed upload: data=%q read=%v context=%v", data, err, ctx.Err())
						}
						return model.Attachment{}, false, nil, &model.Fault{Code: "path_conflict", Message: "conflict"}
					},
					List: func(ctx context.Context, p model.Principal, project, id string, request model.PageRequest) (attachmentcore.Page, error) {
						if lists.Add(1) != 1 || ctx.Err() != nil || p != principal || project != task.ProjectID || id != task.ID {
							t.Error("unexpected reused connection request")
						}
						return attachmentcore.Page{Items: []model.Attachment{}}, nil
					},
				}
				mux := http.NewServeMux()
				attachmenthttp.RegisterRoutesWithOperationsForTest(mux, ops, auth.Require, logger, time.Second)
				handler := httpx.RequestLogging(logger, attachmenthttp.PathGuard(mux, logger))
				handler.ServeHTTP(&reusableRejectionWriter{ResponseWriter: w, failClear: failClear, deadlines: deadlines}, r)
			}))
			t.Cleanup(server.Close)
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nX-Request-ID: consumed-conflict\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nabc", attachmentFilePath(task, "parent/child"), token)
			if err != nil {
				t.Fatal(err)
			}
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if readErr != nil && !(failClear && errors.Is(readErr, io.ErrUnexpectedEOF)) {
				t.Fatal(readErr)
			}
			if response.StatusCode != http.StatusConflict || response.Close || !strings.Contains(string(data), `"code":"path_conflict"`) || !strings.Contains(string(data), `"requestId":"consumed-conflict"`) {
				t.Fatalf("status=%s close=%v body=%q read=%v", response.Status, response.Close, data, readErr)
			}
			for i := 0; i < 2; i++ {
				select {
				case deadline := <-deadlines:
					if i == 0 && (deadline.IsZero() || time.Until(deadline) > time.Second) || i == 1 && !deadline.IsZero() {
						t.Fatalf("write deadline %d = %v", i, deadline)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("write deadline was not set and cleared")
				}
			}
			if failClear {
				if _, err := reader.ReadByte(); err != io.EOF {
					t.Fatalf("connection remained usable after failed deadline restoration: %v", err)
				}
				select {
				case output := <-logs:
					if !strings.Contains(output, `"phase":"rejection clear deadline"`) || !strings.Contains(output, `"request_id":"consumed-conflict"`) || strings.Contains(output, "private deadline") || strings.Contains(output, `"status":200`) {
						t.Fatalf("restoration failure logs: %s", output)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("restoration failure did not finish")
				}
				if uploads.Load() != 1 || lists.Load() != 0 {
					t.Fatalf("failure calls: upload=%d list=%d", uploads.Load(), lists.Load())
				}
				return
			}
			_, err = fmt.Fprintf(conn, "GET %s/attachments HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n", taskPath(task), token)
			if err != nil {
				t.Fatal(err)
			}
			next, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			_, readErr = io.Copy(io.Discard, next.Body)
			_ = next.Body.Close()
			if readErr != nil || next.StatusCode != http.StatusOK {
				t.Fatalf("reused response=%s read=%v", next.Status, readErr)
			}
			if uploads.Load() != 1 || lists.Load() != 1 {
				t.Fatalf("reuse calls: upload=%d list=%d", uploads.Load(), lists.Load())
			}
		})
	}
}
