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
	started   bool
	directory string
	canStop   func() bool
	closeOnce sync.Once
}

func StartGateway(t testing.TB, callbackURL string) *Fixture {
	t.Helper()
	return StartGatewayWithOutput(t, callbackURL, io.Discard)
}

func StartGatewayWithOutput(t testing.TB, callbackURL string, output io.Writer) *Fixture {
	t.Helper()
	return startGateway(t, callbackURL, output, func() bool { return true })
}

// StartGatewayGuarded retains the gateway when its owning service has not stopped.
func StartGatewayGuarded(t testing.TB, callbackURL string, canStop func() bool) *Fixture {
	t.Helper()
	if canStop == nil {
		t.Fatal("authentication fixture requires a cleanup guard")
	}
	return startGateway(t, callbackURL, io.Discard, canStop)
}

func startGateway(t testing.TB, callbackURL string, output io.Writer, canStop func() bool) *Fixture {
	t.Helper()
	binary := os.Getenv("DAYNIGHT_TEST_UNIAUTH_FIXTURE")
	if binary == "" {
		t.Fatal("DAYNIGHT_TEST_UNIAUTH_FIXTURE is required")
	}
	f := &Fixture{exited: make(chan struct{}), canStop: canStop}
	directory := fixtureDirectory(t, f.canRemoveDirectory)
	f.directory = directory
	ready := filepath.Join(directory, "ready.json")
	f.command = exec.Command(binary)
	f.command.Env = append(os.Environ(), "DAYNIGHT_FIXTURE_CALLBACK_URL="+callbackURL, "DAYNIGHT_FIXTURE_DATABASE_PATH="+filepath.Join(directory, "apps.db"), "DAYNIGHT_FIXTURE_READY_FILE="+ready, "DAYNIGHT_FIXTURE_LISTEN_ADDRESS=127.0.0.1:0", "DAYNIGHT_FIXTURE_PUBLIC_URL=")
	f.command.Stdout, f.command.Stderr = output, output
	if err := f.command.Start(); err != nil {
		t.Fatal("start real UniAuth fixture failed")
	}
	f.started = true
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
	return fixtureDirectory(t, func() bool { return true })
}

func removeFixtureDirectory(directory string, stopped bool) error {
	if !stopped {
		return errors.New("authentication fixture directory retained because process exit is unconfirmed")
	}
	if err := os.RemoveAll(directory); err != nil {
		return errors.New("remove authentication fixture directory failed")
	}
	return nil
}

func fixtureDirectory(t testing.TB, stopped func() bool) string {
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
		if err := removeFixtureDirectory(directory, stopped()); err != nil {
			t.Error(err)
		}
	})
	return directory
}

type fixtureProcess interface {
	Signal(os.Signal) error
	Kill() error
}

func stopFixtureProcess(process fixtureProcess, exited <-chan struct{}, allowed bool, graceful, forced time.Duration) (bool, error) {
	if !allowed {
		return false, errors.New("authentication fixture retained because owning service exit is unconfirmed")
	}
	select {
	case <-exited:
		return true, nil
	default:
	}
	signalErr := process.Signal(syscall.SIGTERM)
	if errors.Is(signalErr, os.ErrProcessDone) {
		signalErr = nil
	}
	timer := time.NewTimer(graceful)
	defer timer.Stop()
	select {
	case <-exited:
		return true, signalErr
	case <-timer.C:
	}
	killErr := process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	deadline := time.NewTimer(forced)
	defer deadline.Stop()
	select {
	case <-exited:
		return true, errors.Join(signalErr, killErr, errors.New("real UniAuth fixture exceeded graceful shutdown deadline"))
	case <-deadline.C:
		return false, errors.Join(signalErr, killErr, errors.New("real UniAuth fixture could not be reaped within the deadline"))
	}
}

func (f *Fixture) Close(t testing.TB) {
	t.Helper()
	f.closeOnce.Do(func() {
		stopped, err := stopFixtureProcess(f.command.Process, f.exited, f.canStop(), 5*time.Second, 2*time.Second)
		if err != nil {
			if !stopped {
				t.Errorf("%v: pid=%d directory=%s", err, f.command.Process.Pid, f.directory)
			} else {
				t.Error(err)
			}
		}
		if stopped && f.waitError != nil {
			t.Error("real UniAuth fixture did not exit successfully")
		}
	})
}

func (f *Fixture) canRemoveDirectory() bool {
	if !f.canStop() {
		return false
	}
	if !f.started {
		return true
	}
	select {
	case <-f.exited:
		return true
	default:
		return false
	}
}

// CleanupConfirmed reports only a stopped process whose private directory is gone.
func (f *Fixture) CleanupConfirmed() bool {
	if !f.started || !f.canRemoveDirectory() {
		return false
	}
	_, err := os.Stat(f.directory)
	return errors.Is(err, os.ErrNotExist)
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
	loginURL := origin + "/api/v1/auth/login?provider=github"
	authorize := location(t, request(t, browser, http.MethodGet, loginURL, "", http.StatusSeeOther))
	if authorize.String() == loginURL {
		authorize = location(t, request(t, browser, http.MethodGet, loginURL, "", http.StatusSeeOther))
	}
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
