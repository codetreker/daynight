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
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

type completedAttachmentBody struct {
	io.ReadCloser
	content []byte
}

func (b *completedAttachmentBody) Read(buffer []byte) (int, error) {
	count, err := b.ReadCloser.Read(buffer)
	b.content = append(b.content, buffer[:count]...)
	return count, err
}

type attachmentResponseObservation struct {
	requestError error
	content      string
	deadlines    []time.Time
}

type attachmentBodyCompletionObserver struct {
	http.ResponseWriter
	request       *http.Request
	body          *completedAttachmentBody
	deadlines     []time.Time
	before        chan<- attachmentResponseObservation
	continueWrite <-chan struct{}
}

func (w *attachmentBodyCompletionObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *attachmentBodyCompletionObserver) SetReadDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func (w *attachmentBodyCompletionObserver) WriteHeader(status int) {
	w.before <- attachmentResponseObservation{requestError: w.request.Context().Err(), content: string(w.body.content), deadlines: append([]time.Time(nil), w.deadlines...)}
	<-w.continueWrite
	w.ResponseWriter.WriteHeader(status)
}

func TestAttachmentConsumedBodyMetadataFailureKeepsSocketReusable(t *testing.T) {
	task := api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString()}
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	token := "dnpat_" + strings.Repeat("A", 43)
	path := "metadata-failure"
	metadataError := errors.New("injected metadata failure")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var authentications, uploads, lists atomic.Int32
	var listAllowed atomic.Bool
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		if authentications.Add(1) > 2 || ctx.Err() != nil || kind != model.PATCredential || credential != token {
			t.Error("unexpected body-completion authentication")
			return model.Principal{}, errors.New("unexpected authentication")
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	operations := attachmenthttp.AttachmentOperationsForTest{
		PutRetained: func(ctx context.Context, p model.Principal, project, id, actualPath, contentType string, content io.Reader) (model.Attachment, bool, io.Closer, error) {
			if uploads.Add(1) != 1 || ctx.Err() != nil || p != principal || project != task.ProjectID || id != task.ID || actualPath != path || contentType != "text/plain" {
				t.Error("unexpected attachment upload arguments")
				return model.Attachment{}, false, nil, errors.New("unexpected upload")
			}
			if _, ok := content.(*httpx.DeadlineBody); !ok {
				t.Error("attachment upload did not receive the real deadline body")
			}
			data, err := io.ReadAll(content)
			if err != nil || string(data) != "abc" || ctx.Err() != nil {
				t.Errorf("attachment body = %q, read = %v, context = %v", data, err, ctx.Err())
			}
			return model.Attachment{}, false, nil, metadataError
		},
		List: func(ctx context.Context, p model.Principal, project, id string, request model.PageRequest) (attachmentcore.Page, error) {
			if lists.Add(1) != 1 || !listAllowed.Load() || ctx.Err() != nil || p != principal || project != task.ProjectID || id != task.ID || !reflect.DeepEqual(request, model.PageRequest{Limit: 50}) {
				t.Error("unexpected attachment list arguments or ordering")
				return attachmentcore.Page{}, errors.New("unexpected list")
			}
			return attachmentcore.Page{Items: []model.Attachment{}}, nil
		},
		Delete: func(context.Context, model.Principal, string, string, string) error {
			t.Error("unexpected attachment deletion")
			return errors.New("unexpected deletion")
		},
		Open: func(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error) {
			t.Error("unexpected attachment open")
			return model.Attachment{}, filestorage.Object{}, errors.New("unexpected open")
		},
	}
	t.Cleanup(func() {
		if authentications.Load() != 2 || uploads.Load() != 1 || lists.Load() != 1 {
			t.Errorf("body-completion calls: authentication=%d upload=%d list=%d", authentications.Load(), uploads.Load(), lists.Load())
		}
	})
	mux := http.NewServeMux()
	attachmenthttp.RegisterRoutesWithOperationsForTest(mux, operations, auth.Require, logger, attachmenthttp.DefaultBodyReadTimeout())
	handler := httpx.RequestLogging(logger, attachmenthttp.PathGuard(mux, logger))
	before := make(chan attachmentResponseObservation, 2)
	continueWrite := make(chan struct{}, 2)
	defer close(continueWrite)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := &completedAttachmentBody{ReadCloser: r.Body}
		r.Body = body
		handler.ServeHTTP(&attachmentBodyCompletionObserver{ResponseWriter: w, request: r, body: body, before: before, continueWrite: continueWrite}, r)
	}))
	t.Cleanup(server.Close)
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nabc", attachmentFilePath(task, path), token)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observed := <-before:
		if observed.requestError != nil || observed.content != "abc" {
			t.Fatalf("metadata rejection consumed %q with context error %v", observed.content, observed.requestError)
		}
		if len(observed.deadlines) != 2 || observed.deadlines[0].IsZero() || !observed.deadlines[1].IsZero() {
			t.Fatalf("completed attachment read deadlines = %v, want a bound followed by clearing", observed.deadlines)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("metadata rejection did not reach the response barrier")
	}
	continueWrite <- struct{}{}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, readError := io.ReadAll(response.Body)
	closeError := response.Body.Close()
	if readError != nil || closeError != nil || response.StatusCode != http.StatusInternalServerError || response.Close || !strings.Contains(string(data), `"code":"internal_error"`) {
		t.Fatalf("metadata status=%d close=%v body=%q read=%v closeError=%v", response.StatusCode, response.Close, data, readError, closeError)
	}
	listAllowed.Store(true)
	_, err = fmt.Fprintf(conn, "GET %s/attachments HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n", taskPath(task), token)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observed := <-before:
		if observed.requestError != nil {
			t.Fatalf("keep-alive request canceled: %v", observed.requestError)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("keep-alive request did not reach the response barrier")
	}
	continueWrite <- struct{}{}
	response, err = http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, readError = io.Copy(io.Discard, response.Body)
	closeError = response.Body.Close()
	if readError != nil || closeError != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("keep-alive status=%d read=%v close=%v", response.StatusCode, readError, closeError)
	}
}
