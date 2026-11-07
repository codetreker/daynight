package service

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	coreidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func identityEnvelope(size int) []byte {
	const prefix = `{"provider":"github","id":"id","email":null,"email_verified":null,"name":null,"avatar_url":null,"origin":{},"padding":"`
	const suffix = `"}`
	return []byte(prefix + strings.Repeat("x", size-len(prefix)-len(suffix)) + suffix)
}

func TestIdentityHTTPActualResponses(t *testing.T) {
	for _, encoding := range []string{"plain", "chunked", "gzip"} {
		for _, extra := range []int{0, 1} {
			t.Run(encoding+"/"+string(rune('0'+extra)), func(t *testing.T) {
				body := identityEnvelope(coreidentity.MaxIdentityResponseBytes + extra)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					switch encoding {
					case "plain":
						w.Header().Set("Content-Length", strconv.Itoa(len(body)))
					case "chunked":
						w.WriteHeader(http.StatusOK)
						w.(http.Flusher).Flush()
					case "gzip":
						w.Header().Set("Content-Encoding", "gzip")
						gz := gzip.NewWriter(w)
						_, _ = gz.Write(body)
						_ = gz.Close()
						return
					}
					_, _ = w.Write(body)
				}))
				defer server.Close()
				client, err := NewIdentityClient(config.Config{UniAuthURL: server.URL, UniAuthAppID: "app", UniAuthAppSecret: "secret", AllowLoopbackHTTP: true})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				identity, err := client.Retrieve(ctx, "code")
				if extra == 0 {
					if err != nil || identity == nil || len(identity.RawJSON) != coreidentity.MaxIdentityResponseBytes {
						t.Fatalf("exact response: identity=%v error=%v", identity != nil, err)
					}
				} else if identity != nil || !errors.Is(err, errIdentityResponseTooLarge) {
					t.Fatalf("oversized response: identity=%v error=%v", identity != nil, err)
				}
			})
		}
	}
}

type responseTransportFunc func(*http.Request) (*http.Response, error)

func (f responseTransportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type trackedIdentityBody struct {
	reader   io.Reader
	read     int
	closed   bool
	closeErr error
}

func (b *trackedIdentityBody) Read(p []byte) (int, error) {
	n, err := b.reader.Read(p)
	b.read += n
	return n, err
}
func (b *trackedIdentityBody) Close() error { b.closed = true; return b.closeErr }

func TestIdentityHTTPStopsAndPreservesBodyErrors(t *testing.T) {
	closeErr := errors.New("close failure")
	body := &trackedIdentityBody{reader: strings.NewReader(strings.Repeat("x", coreidentity.MaxIdentityResponseBytes+10000)), closeErr: closeErr}
	client, err := uniauth.New(uniauth.Config{BaseURL: "https://identity.example", AppID: "app", AppSecret: "secret", HTTPClient: &http.Client{Transport: identityResponseTransport{base: responseTransportFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, ContentLength: 1, Body: body}, nil
	})}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Retrieve(context.Background(), "code")
	if !errors.Is(err, errIdentityResponseTooLarge) || !errors.Is(err, closeErr) || !body.closed || body.read != coreidentity.MaxIdentityResponseBytes+1 {
		t.Fatalf("read=%d closed=%v error=%v", body.read, body.closed, err)
	}
	if strings.Contains(err.Error(), "xxxxx") {
		t.Fatal("response contents leaked")
	}

	readErr := errors.New("read failure")
	body = &trackedIdentityBody{reader: errorReader{readErr}, closeErr: closeErr}
	_, err = client.Retrieve(context.Background(), "code")
	if !errors.Is(err, readErr) || !errors.Is(err, closeErr) || !body.closed {
		t.Fatalf("body errors: %v", err)
	}
	body = &trackedIdentityBody{reader: bytes.NewReader(identityEnvelope(256)), closeErr: closeErr}
	identity, err := client.Retrieve(context.Background(), "code")
	if identity != nil || !errors.Is(err, closeErr) || !body.closed {
		t.Fatalf("close failure accepted a profile: %v", err)
	}
}

type errorReader struct{ err error }

func (r errorReader) Read([]byte) (int, error) { return 0, r.err }

type byteAndErrorReader struct{ err error }

func (r byteAndErrorReader) Read(p []byte) (int, error) { p[0] = 'x'; return 1, r.err }

func TestIdentityHTTPTransportAndProbeErrors(t *testing.T) {
	cause := errors.New("transport failure")
	transport := identityResponseTransport{base: responseTransportFunc(func(*http.Request) (*http.Response, error) { return nil, cause })}
	request := httptest.NewRequest(http.MethodGet, "https://identity.example", nil)
	if _, err := transport.RoundTrip(request); !errors.Is(err, cause) {
		t.Fatalf("transport error: %v", err)
	}
	body := &identityResponseBody{body: io.NopCloser(byteAndErrorReader{cause})}
	if n, err := body.Read(nil); n != 0 || err != nil {
		t.Fatalf("empty read: %d %v", n, err)
	}
	if n, err := body.Read(make([]byte, 2)); n != 0 || !errors.Is(err, cause) || !errors.Is(err, errIdentityResponseTooLarge) {
		t.Fatalf("overflow probe: %d %v", n, err)
	}
	if n, err := body.Read(make([]byte, 2)); n != 0 || !errors.Is(err, errIdentityResponseTooLarge) {
		t.Fatalf("overflow was not retained: %d %v", n, err)
	}
}

func TestIdentityHTTPMalformedCancelAndRedirect(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	client, err := NewIdentityClient(config.Config{UniAuthURL: server.URL, UniAuthAppID: "app", UniAuthAppSecret: "secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := client.Retrieve(ctx, "code"); done <- err }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel cause: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not stop body read")
	}
	var count atomic.Int32
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		http.Redirect(w, r, "/other", http.StatusFound)
	}))
	defer redirect.Close()
	client, err = NewIdentityClient(config.Config{UniAuthURL: redirect.URL, UniAuthAppID: "app", UniAuthAppSecret: "secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Retrieve(context.Background(), "code")
	if err == nil || count.Load() != 1 {
		t.Fatalf("redirect was followed: count=%d error=%v", count.Load(), err)
	}

	malformed := &trackedIdentityBody{reader: bytes.NewBufferString(`{"provider":`)}
	client, err = uniauth.New(uniauth.Config{BaseURL: "https://identity.example", AppID: "app", AppSecret: "secret", HTTPClient: &http.Client{Transport: identityResponseTransport{base: responseTransportFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: malformed}, nil
	})}}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Retrieve(context.Background(), "code")
	var protocol *uniauth.ProtocolError
	if !errors.As(err, &protocol) || protocol.Cause == nil || !malformed.closed {
		t.Fatalf("malformed JSON: %v", err)
	}
}
