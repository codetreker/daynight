package httpx

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
	"testing"
	"time"
)

type rejectionControlWriter struct {
	http.ResponseWriter
	deadlineErr, clearErr, flushErr error
	deadlines                       chan time.Time
}

func (w *rejectionControlWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *rejectionControlWriter) SetWriteDeadline(deadline time.Time) error {
	if w.deadlines != nil {
		w.deadlines <- deadline
	}
	if deadline.IsZero() && w.clearErr != nil {
		return w.clearErr
	}
	if w.deadlineErr != nil {
		return w.deadlineErr
	}
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}

func (w *rejectionControlWriter) FlushError() error {
	if w.flushErr != nil {
		return w.flushErr
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}

type bodyCloseObservation struct {
	before, after error
	close         error
}

type observedCloseBody struct {
	io.ReadCloser
	ctx         context.Context
	observation *bodyCloseObservation
}

func (b *observedCloseBody) Close() error {
	b.observation.before = b.ctx.Err()
	err := b.ReadCloser.Close()
	b.observation.after = b.ctx.Err()
	b.observation.close = err
	return err
}

func TestBodyLimitRejectionAfterTransportCancellation(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		t.Run(map[bool]string{false: "content length", true: "chunked"}[chunked], func(t *testing.T) {
			observed := make(chan bodyCloseObservation, 1)
			deadlines := make(chan time.Time, 2)
			server := httptest.NewServer(RequestLogging(quietLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/next" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w = &rejectionControlWriter{ResponseWriter: w, deadlines: deadlines}
				observation := bodyCloseObservation{}
				r.Body = &observedCloseBody{ReadCloser: r.Body, ctx: r.Context(), observation: &observation}
				_, err := ReadBody(w, r, 8, time.Second)
				observed <- observation
				WriteBodyError(w, r, quietLogger(), "test", "read", err)
			})))
			t.Cleanup(server.Close)
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			framing := "Content-Length: 9\r\n\r\n123456789"
			if chunked {
				// Withhold the terminal chunk so native Body.Close must attempt a
				// socket read after ReadBody has expired the read deadline.
				framing = "Transfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n"
			}
			if _, err := fmt.Fprint(conn, "POST / HTTP/1.1\r\nHost: localhost\r\nX-Request-ID: body-close-observation\r\n"+framing); err != nil {
				t.Fatal(err)
			}
			var observation bodyCloseObservation
			select {
			case observation = <-observed:
			case <-time.After(5 * time.Second):
				t.Fatal("body close did not reach observation barrier")
			}
			if observation.before != nil {
				t.Fatalf("context canceled before body close: %v", observation.before)
			}
			if chunked {
				var timeout net.Error
				if !errors.Is(observation.after, context.Canceled) || !errors.As(observation.close, &timeout) || !timeout.Timeout() {
					t.Fatalf("close did not cancel through socket timeout: %+v", observation)
				}
			} else if observation.after != nil || observation.close != nil {
				t.Fatalf("complete known-length close failed: %+v", observation)
			}
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != http.StatusRequestEntityTooLarge || response.Close != chunked || !strings.Contains(string(body), `"code":"payload_too_large"`) || !strings.Contains(string(body), `"requestId":"body-close-observation"`) {
				t.Fatalf("close observation=%+v response=%s close=%v body=%q read=%v", observation, response.Status, response.Close, body, err)
			}
			select {
			case deadline := <-deadlines:
				if deadline.IsZero() || time.Until(deadline) > time.Second {
					t.Fatalf("rejection write deadline is not bounded: %v", deadline)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("rejection did not apply a real write deadline")
			}
			if chunked {
				if _, err := reader.ReadByte(); err != io.EOF {
					t.Fatalf("incomplete rejected connection remained reusable: %v", err)
				}
			} else {
				select {
				case deadline := <-deadlines:
					if !deadline.IsZero() {
						t.Fatalf("complete rejected body retained write deadline: %v", deadline)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("complete rejected body did not clear write deadline")
				}
				if _, err := fmt.Fprint(conn, "GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"); err != nil {
					t.Fatal(err)
				}
				next, err := http.ReadResponse(reader, nil)
				if err != nil {
					t.Fatal(err)
				}
				_ = next.Body.Close()
				if next.StatusCode != http.StatusNoContent {
					t.Fatalf("complete rejected body damaged keepalive: %s", next.Status)
				}
			}
		})
	}
}

func TestBodyRejectionControlFailureAbortsSocket(t *testing.T) {
	for _, phase := range []string{"write deadline", "flush", "clear deadline"} {
		t.Run(phase, func(t *testing.T) {
			cause := errors.New("private socket failure")
			logs := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var output strings.Builder
				logger := slog.New(slog.NewJSONHandler(&output, nil))
				defer func() { logs <- output.String() }()
				writer := &rejectionControlWriter{ResponseWriter: w}
				switch phase {
				case "write deadline":
					writer.deadlineErr = cause
				case "flush":
					writer.flushErr = cause
				case "clear deadline":
					writer.clearErr = cause
				}
				RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					err := &BodyReadError{Cause: &http.MaxBytesError{Limit: 8}, Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "request body exceeds its input limit"}
					WriteBodyError(w, r, logger, "test", "read", err)
				})).ServeHTTP(writer, r)
			}))
			t.Cleanup(server.Close)
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fprint(conn, "GET / HTTP/1.1\r\nHost: localhost\r\nX-Request-ID: failed-body-rejection\r\n\r\n"); err != nil {
				t.Fatal(err)
			}
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if phase == "clear deadline" {
				if err != nil || response.StatusCode != http.StatusRequestEntityTooLarge {
					t.Fatalf("already sent rejection was lost: response=%v error=%v", response, err)
				}
				body, err := io.ReadAll(response.Body)
				if err != nil && err != io.ErrUnexpectedEOF || !strings.Contains(string(body), `"code":"payload_too_large"`) {
					t.Fatalf("aborted rejection lost its payload or transport failure: body=%q error=%v", body, err)
				}
				_ = response.Body.Close()
				if _, err := reader.ReadByte(); err != io.EOF {
					t.Fatalf("failed deadline restoration retained connection: %v", err)
				}
			} else if response != nil || err != io.ErrUnexpectedEOF {
				t.Fatalf("failed transport emitted a response instead of aborting: response=%v error=%v", response, err)
			}
			select {
			case output := <-logs:
				if !strings.Contains(output, `"error_code":"payload_too_large"`) || !strings.Contains(output, `"phase":"body rejection `+phase+`"`) || !strings.Contains(output, `"request_id":"failed-body-rejection"`) || strings.Contains(output, cause.Error()) || strings.Contains(output, `"status":200`) {
					t.Fatalf("unsafe or incomplete abort diagnostics: %s", output)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("abort did not complete handler")
			}
		})
	}
}

func TestBodyRejectionPreservesOrdinaryCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("private input")).WithContext(ctx)
	w := httptest.NewRecorder()
	err := &BodyReadError{Cause: context.Canceled, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
	WriteBodyError(w, r, quietLogger(), "test", "read", err)
	if w.Body.Len() != 0 || !errors.Is(r.Context().Err(), context.Canceled) {
		t.Fatalf("ordinary canceled read became a response: body=%q context=%v", w.Body.String(), r.Context().Err())
	}
}
