package session

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type countedUploadListener struct {
	net.Listener
	read atomic.Int64
}

func (l *countedUploadListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &countedUploadConn{Conn: c, read: &l.read}, nil
}

type countedUploadConn struct {
	net.Conn
	read *atomic.Int64
}

type uploadReadProbe struct{ reads int }

func (p *uploadReadProbe) Read([]byte) (int, error) {
	p.reads++
	return 0, errors.New("unexpected read")
}
func (*uploadReadProbe) Close() error { return nil }

func TestDeprecatedControllerUploadNeverConsumesBody(t *testing.T) {
	for _, token := range []string{"dncontroller_forged", "wrong"} {
		probe := &uploadReadProbe{}
		req := httptest.NewRequest(http.MethodPut, "/", nil)
		req.Body, req.ContentLength = probe, 8<<20
		req.SetPathValue("resourceId", "a5f255cf-a49f-4fa2-9367-9c474397b734")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Daynight-Connection-Epoch", "1")
		res := httptest.NewRecorder()
		(&Routes{logger: testLogger()}).putResource(res, req)
		if probe.reads != 0 || !req.Close || res.Header().Get("Connection") != "close" {
			t.Fatalf("token %q: reads=%d close=%v headers=%v", token, probe.reads, req.Close, res.Header())
		}
		if token == "dncontroller_forged" && res.Code != http.StatusNotFound || token == "wrong" && res.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: status=%d", token, res.Code)
		}
	}
}

func (c *countedUploadConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.read.Add(int64(n))
	return n, err
}

func TestDeprecatedControllerUploadDoesNotReadOrDrainBody(t *testing.T) {
	for _, transfer := range []struct {
		name, framing, prefix string
	}{
		{"length", "Content-Length: 8388609\r\n", ""},
		{"chunked", "Transfer-Encoding: chunked\r\n", "100000\r\n"},
	} {
		t.Run(transfer.name, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			routes := &Routes{logger: testLogger()}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.SetPathValue("resourceId", "a5f255cf-a49f-4fa2-9367-9c474397b734")
				close(entered)
				<-release
				routes.putResource(w, r)
			}))
			listener := &countedUploadListener{Listener: server.Listener}
			server.Listener = listener
			server.Start()
			defer server.Close()
			conn, err := net.DialTimeout("tcp", listener.Addr().String(), 2*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			head := "PUT /api/v1/controller-resources/a5f255cf-a49f-4fa2-9367-9c474397b734 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer dncontroller_forged\r\nDaynight-Connection-Epoch: 1\r\n" + transfer.framing + "\r\n" + transfer.prefix
			// Body bytes in the first write may be prefetched into net/http's
			// bounded header buffer; later bytes expose an attempted drain.
			if _, err := io.WriteString(conn, head+strings.Repeat("x", 100)); err != nil {
				t.Fatal(err)
			}
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("handler did not receive headers")
			}
			if _, err := io.WriteString(conn, strings.Repeat("x", 64<<10)); err != nil {
				close(release)
				t.Fatal(err)
			}
			close(release)
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPut})
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || response.StatusCode != http.StatusNotFound || !response.Close || !strings.Contains(string(body), `"code":"not_found"`) {
				t.Fatalf("response: %v, %q, %v", response, body, err)
			}
			_, err = reader.ReadByte()
			var networkErr net.Error
			if err == nil || errors.As(err, &networkErr) && networkErr.Timeout() {
				t.Fatalf("connection remained usable or failed to close: %v", err)
			}
			if got := listener.read.Load(); got > 4096 {
				t.Fatalf("server read %d bytes; only header-buffer prefetch is allowed", got)
			}
		})
	}
}
