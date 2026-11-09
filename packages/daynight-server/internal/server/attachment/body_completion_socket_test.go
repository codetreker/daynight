package attachment_test

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	f := newAttachmentFixture(t, attachmentTestFiles(t), io.Discard)
	path := "metadata-failure"
	metadataError := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("injected metadata failure")}
	f.expectPut(f.task, path, "text/plain", 3, model.Attachment{}, false)
	f.dao.putFn = func(_ context.Context, item model.Attachment) (model.Attachment, bool, error) {
		f.called("put attachment")
		expected := model.Attachment{ProjectID: f.task.ProjectID, TaskID: f.task.ID, Path: path, ContentType: "text/plain", SizeBytes: 3}
		if !reflect.DeepEqual(item, expected) {
			t.Errorf("metadata write = %+v, want %+v", item, expected)
		}
		return model.Attachment{}, false, metadataError
	}
	before := make(chan attachmentResponseObservation, 2)
	continueWrite := make(chan struct{}, 2)
	defer close(continueWrite)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := &completedAttachmentBody{ReadCloser: r.Body}
		r.Body = body
		f.handler.ServeHTTP(&attachmentBodyCompletionObserver{ResponseWriter: w, request: r, body: body, before: before, continueWrite: continueWrite}, r)
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
	_, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nabc", attachmentFilePath(f.task, path), f.handler.token)
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
	f.verify()
	f.expectList(f.task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{}, nil)
	_, err = fmt.Fprintf(conn, "GET %s/attachments HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n", taskPath(f.task), f.handler.token)
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
	f.verify()
}
