package testauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Fixture runs the pinned UniAuth gateway; only its external GitHub transport is controlled.
type Fixture struct {
	Origin    string `json:"origin"`
	AppID     string `json:"appId"`
	AppSecret string `json:"appSecret"`
	command   *exec.Cmd
	exited    chan struct{}
	waitError error
	closeOnce sync.Once
}

func StartGateway(t testing.TB, callbackURL string) *Fixture {
	t.Helper()
	return StartGatewayWithOutput(t, callbackURL, io.Discard)
}

func StartGatewayWithOutput(t testing.TB, callbackURL string, output io.Writer) *Fixture {
	t.Helper()
	binary := os.Getenv("DAYNIGHT_TEST_UNIAUTH_FIXTURE")
	if binary == "" {
		t.Fatal("DAYNIGHT_TEST_UNIAUTH_FIXTURE is required")
	}
	directory := Directory(t)
	ready := filepath.Join(directory, "ready.json")
	f := &Fixture{exited: make(chan struct{})}
	f.command = exec.Command(binary)
	f.command.Env = append(os.Environ(), "DAYNIGHT_FIXTURE_CALLBACK_URL="+callbackURL, "DAYNIGHT_FIXTURE_DATABASE_PATH="+filepath.Join(directory, "apps.db"), "DAYNIGHT_FIXTURE_READY_FILE="+ready, "DAYNIGHT_FIXTURE_LISTEN_ADDRESS=127.0.0.1:0", "DAYNIGHT_FIXTURE_PUBLIC_URL=")
	f.command.Stdout, f.command.Stderr = output, output
	if err := f.command.Start(); err != nil {
		t.Fatal("start real UniAuth fixture failed")
	}
	go func() { f.waitError = f.command.Wait(); close(f.exited) }()
	t.Cleanup(func() { f.Close(t) })
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for {
		data, err := os.ReadFile(ready)
		if err == nil {
			info, err := os.Stat(ready)
			if err != nil || info.Mode().Perm() != 0o600 {
				t.Fatal("fixture readiness must be a private file")
			}
			if json.Unmarshal(data, f) != nil || f.Origin == "" || f.AppID == "" || f.AppSecret == "" {
				t.Fatal("invalid fixture readiness")
			}
			if os.Remove(ready) != nil {
				t.Fatal("remove private fixture readiness failed")
			}
			return f
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatal("read fixture readiness failed")
		}
		select {
		case <-f.exited:
			t.Fatal("real UniAuth fixture exited before readiness")
		case <-deadline.C:
			t.Fatal("real UniAuth fixture readiness deadline exceeded")
		case <-poll.C:
		}
	}
}

func Directory(t testing.TB) string {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal("locate fixture module failed")
	}
	for {
		if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
			break
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatal("inspect fixture module failed")
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Fatal("fixture module root was not found")
		}
		root = parent
	}
	parent := filepath.Join(root, ".tmp", "auth-fixtures")
	if os.MkdirAll(parent, 0o700) != nil {
		t.Fatal("prepare project fixture directory failed")
	}
	directory, err := os.MkdirTemp(parent, "gateway-")
	if err != nil {
		t.Fatal("create project fixture directory failed")
	}
	t.Cleanup(func() {
		if os.RemoveAll(directory) != nil {
			t.Error("remove authentication fixture directory failed")
		}
	})
	return directory
}

func (f *Fixture) Close(t testing.TB) {
	t.Helper()
	f.closeOnce.Do(func() {
		select {
		case <-f.exited:
		default:
			if err := f.command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Error("signal real UniAuth fixture shutdown failed")
			}
			select {
			case <-f.exited:
			case <-time.After(5 * time.Second):
				if err := f.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
					t.Error("kill real UniAuth fixture failed")
				}
				<-f.exited
				t.Error("real UniAuth fixture exceeded graceful shutdown deadline")
			}
		}
		if f.waitError != nil {
			t.Error("real UniAuth fixture did not exit successfully")
		}
	})
}

func Browser(t testing.TB) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal("create fixture browser cookie jar failed")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Jar: jar, Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func request(t testing.TB, browser *http.Client, method, address, body string, status int) *http.Response {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, address, strings.NewReader(body))
	if err != nil {
		t.Fatal("construct authentication fixture request failed")
	}
	if body != "" {
		u, err := url.Parse(address)
		if err != nil {
			t.Fatal("parse authentication fixture origin failed")
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", u.Scheme+"://"+u.Host)
	}
	response, err := browser.Do(req)
	if err != nil {
		t.Fatal("authentication fixture HTTP request failed")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatal("read authentication fixture response failed")
	}
	response.Body = io.NopCloser(strings.NewReader(string(data)))
	if response.StatusCode != status {
		t.Fatalf("authentication fixture %s %s returned HTTP %d; want %d", method, req.URL.Path, response.StatusCode, status)
	}
	return response
}

func location(t testing.TB, response *http.Response) *url.URL {
	t.Helper()
	u, err := response.Location()
	response.Body.Close()
	if err != nil {
		t.Fatal("authentication fixture redirect is missing")
	}
	return u
}

func Login(t testing.TB, browser *http.Client, origin, persona string) {
	t.Helper()
	authorize := location(t, request(t, browser, http.MethodGet, origin+"/api/v1/auth/login?provider=github", "", http.StatusSeeOther))
	provider := location(t, request(t, browser, http.MethodGet, authorize.String(), "", http.StatusFound))
	if provider.Scheme != "https" || provider.Host != "github.com" || provider.Path != "/login/oauth/authorize" || provider.Query().Get("code_challenge_method") != "S256" || provider.Query().Get("code_challenge") == "" {
		t.Fatal("real GitHub provider authorization or PKCE challenge changed")
	}
	callback, err := url.Parse(provider.Query().Get("redirect_uri"))
	if err != nil {
		t.Fatal("provider callback URL is invalid")
	}
	callback.RawQuery = url.Values{"state": {provider.Query().Get("state")}, "code": {persona + ":" + provider.Query().Get("code_challenge")}}.Encode()
	product := location(t, request(t, browser, http.MethodGet, callback.String(), "", http.StatusFound))
	if product.Scheme+"://"+product.Host != origin {
		t.Fatal("gateway callback left its registered product origin")
	}
	response := request(t, browser, http.MethodGet, product.String(), "", http.StatusSeeOther)
	response.Body.Close()
}

func CreatePAT(t testing.TB, browser *http.Client, origin string) string {
	t.Helper()
	response := request(t, browser, http.MethodPost, origin+"/api/v1/me/tokens", `{"name":"Acceptance fixture","expiresAt":null}`, http.StatusCreated)
	defer response.Body.Close()
	var result struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(response.Body).Decode(&result) != nil || !strings.HasPrefix(result.Token, "dnpat_") {
		t.Fatal("fixture personal access token response is invalid")
	}
	return result.Token
}
