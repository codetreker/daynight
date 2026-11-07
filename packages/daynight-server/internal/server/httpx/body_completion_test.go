package httpx

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUnreadBodyUsesTransportEOFNotWrapperEOF(t *testing.T) {
	for _, complete := range []bool{false, true} {
		t.Run(map[bool]string{false: "partial", true: "complete"}[complete], func(t *testing.T) {
			w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("1234"))
			handler := RequestLogging(quietLogger(), RequestLogging(quietLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var input io.Reader = r.Body
				if !complete {
					input = io.LimitReader(input, 2)
				}
				if _, err := io.ReadAll(input); err != nil {
					t.Fatal(err)
				}
				// Cloned requests and intervening ResponseWriter wrappers preserve
				// the original transport body's completion state.
				clone := r.WithContext(context.WithValue(r.Context(), struct{}{}, "value"))
				CloseUnreadBody(w, clone)
				if clone.Close == complete {
					t.Fatalf("complete=%v close=%v", complete, clone.Close)
				}
			})))
			handler.ServeHTTP(w, request)
			if complete && len(w.reads) != 0 || !complete && len(w.reads) != 1 {
				t.Fatalf("complete=%v deadlines=%v", complete, w.reads)
			}
		})
	}
}

func TestPartialBodyRejectionClosesSocketWithoutDraining(t *testing.T) {
	read := make(chan string, 1)
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	handler := RequestLogging(quietLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data [2]byte
		_, err := io.ReadFull(r.Body, data[:])
		if err != nil {
			read <- err.Error()
			return
		}
		read <- string(data[:])
		<-release
		WriteError(w, r, quietLogger(), "test", "parse", InvalidInput("invalid body"))
	}))
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprint(conn, "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nab")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-read:
		if got != "ab" {
			t.Fatalf("read = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("body read did not reach barrier")
	}
	close(release)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusBadRequest || !response.Close || !strings.Contains(string(data), `"code":"invalid_input"`) {
		t.Fatalf("status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, data, err)
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("unread connection not closed: %v", err)
	}
}
