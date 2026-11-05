package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	resources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
)

func TestBundledPageAndReferencedAssets(t *testing.T) {
	ui := New(resources.New())
	index, err := resources.New().Read("dist/index.html")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(index, []byte(`<div id="root"></div>`)) || bytes.Contains(index, []byte("/src/main.tsx")) {
		t.Fatal("embedded page is not the production frontend")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := httptest.NewRecorder()
		if err := ui.Page(response, httptest.NewRequest(method, "/", nil)); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/html; charset=utf-8" ||
			response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Length") != strconv.Itoa(len(index)) ||
			method == http.MethodGet && !bytes.Equal(response.Body.Bytes(), index) || method == http.MethodHead && response.Body.Len() != 0 {
			t.Fatalf("page response differs from embedded artifact: %d %+v", response.Code, response.Header())
		}
	}
	assets := regexp.MustCompile(`(?:src|href)="(/assets/[^"?#]+)"`).FindAllStringSubmatch(string(index), -1)
	if len(assets) < 2 {
		t.Fatal("production index does not reference emitted script and stylesheet")
	}
	for _, reference := range assets {
		assetPath := reference[1]
		expected, err := resources.New().Read("dist" + assetPath)
		if err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			response := httptest.NewRecorder()
			if err := ui.Asset(response, httptest.NewRequest(method, assetPath, nil)); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" ||
				response.Header().Get("Content-Length") != strconv.Itoa(len(expected)) ||
				method == http.MethodGet && !bytes.Equal(response.Body.Bytes(), expected) || method == http.MethodHead && response.Body.Len() != 0 {
				t.Fatalf("asset %s differs from production artifact: %d %+v", assetPath, response.Code, response.Header())
			}
			contentType := response.Header().Get("Content-Type")
			if path.Ext(assetPath) == ".js" && !strings.HasPrefix(contentType, "text/javascript") ||
				path.Ext(assetPath) == ".css" && !strings.HasPrefix(contentType, "text/css") {
				t.Fatalf("incorrect asset MIME: %s %s", assetPath, contentType)
			}
		}
	}
}

func TestAssetsRejectDirectoriesMissingAndTraversal(t *testing.T) {
	ui := New(resources.New())
	for _, target := range []string{"/assets/", "/assets/.", "/assets/..", "/assets/../index.html", "/assets//index.js", "/assets/missing.js", "/index.html", "/assets/%2e%2e/index.html", "/assets/nested/../../index.html"} {
		t.Run(target, func(t *testing.T) {
			response := httptest.NewRecorder()
			if err := ui.Asset(response, httptest.NewRequest(http.MethodGet, target, nil)); !errors.Is(err, resources.ErrNotFound) {
				t.Fatalf("asset traversal/directory/missing result: %v", err)
			}
			if response.Body.Len() != 0 || len(response.Header()) != 0 {
				t.Fatal("invalid asset wrote a response")
			}
		})
	}
	files := fstest.MapFS{"dist/assets/folder/file.txt": &fstest.MapFile{Data: []byte("content")}}
	ui = New(resources.NewFromFS(files))
	response := httptest.NewRecorder()
	if err := ui.Asset(response, httptest.NewRequest(http.MethodGet, "/assets/folder", nil)); !errors.Is(err, resources.ErrNotFound) {
		t.Fatalf("directory asset must not be listed: %v", err)
	}
}

func TestUnhashedAssetsAndUnknownExtension(t *testing.T) {
	ui := New(resources.NewFromFS(fstest.MapFS{"dist/assets/plain.txt": &fstest.MapFile{Data: []byte("ordinary asset")},
		"dist/assets/font.daynightbinary": &fstest.MapFile{Data: []byte{0, 1, 2, 3}}}))
	for _, name := range []string{"plain.txt", "font.daynightbinary"} {
		response := httptest.NewRecorder()
		if err := ui.Asset(response, httptest.NewRequest(http.MethodGet, "/assets/"+name, nil)); err != nil {
			t.Fatal(err)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("unhashed asset cannot be cached as immutable")
		}
		if name == "plain.txt" && response.Header().Get("Content-Type") != "text/plain; charset=utf-8" ||
			name == "font.daynightbinary" && response.Header().Get("Content-Type") != "application/octet-stream" {
			t.Fatalf("incorrect asset MIME detection: %+v", response.Header())
		}
	}
}

type resourceFailureFS struct {
	openErr, statErr, readErr, closeErr error
	cancel                              context.CancelFunc
}

func (f resourceFailureFS) Open(string) (fs.File, error) {
	if f.openErr != nil {
		return nil, f.openErr
	}
	file, err := (fstest.MapFS{"file": &fstest.MapFile{Data: []byte("resource")}}).Open("file")
	return &resourceFailureFile{File: file, failure: f}, err
}

type resourceFailureFile struct {
	fs.File
	failure resourceFailureFS
}

func (f *resourceFailureFile) Stat() (fs.FileInfo, error) {
	if f.failure.statErr != nil {
		return nil, f.failure.statErr
	}
	return f.File.Stat()
}

func (f *resourceFailureFile) Read(data []byte) (int, error) {
	if f.failure.cancel != nil {
		f.failure.cancel()
	}
	if f.failure.readErr != nil {
		return 0, f.failure.readErr
	}
	return f.File.Read(data)
}

func (f *resourceFailureFile) Close() error {
	return errors.Join(f.File.Close(), f.failure.closeErr)
}

type failedWriter struct {
	header  http.Header
	partial bool
}

func (w *failedWriter) Header() http.Header { return w.header }
func (*failedWriter) WriteHeader(int)       {}
func (w *failedWriter) Write(data []byte) (int, error) {
	if w.partial {
		return len(data) - 1, nil
	}
	return 0, io.ErrClosedPipe
}

func TestResponseWriteFailuresAndCancellation(t *testing.T) {
	for _, partial := range []bool{false, true} {
		ui := New(resources.New())
		writer := &failedWriter{header: make(http.Header), partial: partial}
		err := ui.Page(writer, httptest.NewRequest(http.MethodGet, "/", nil))
		var responseError *ResponseError
		cause := io.ErrClosedPipe
		if partial {
			cause = io.ErrShortWrite
		}
		if !errors.As(err, &responseError) || !errors.Is(err, cause) || err.Error() != "web response failed" {
			t.Fatalf("write failure lost phase or cause: %v", err)
		}
	}
	for _, duringRead := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		ui := New(resources.New())
		if duringRead {
			ui = New(resources.NewFromFS(resourceFailureFS{cancel: cancel}))
		} else {
			cancel()
		}
		response := httptest.NewRecorder()
		err := ui.Page(response, httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx))
		if !errors.Is(err, context.Canceled) || response.Body.Len() != 0 || len(response.Header()) != 0 {
			t.Fatalf("canceled request wrote a response: %v %+v", err, response)
		}
	}
}

func TestUIErrorsCancellationAndFailedWriteUseSafeSingleBoundary(t *testing.T) {
	for _, err := range []error{errors.New("private-resource-path"), resources.ErrNotFound} {
		var logs bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		handler := httpx.RequestLogging(logger, uiHandler(logger, func(http.ResponseWriter, *http.Request) error { return err }))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
		status, code := http.StatusInternalServerError, "internal_error"
		if errors.Is(err, resources.ErrNotFound) {
			status, code = http.StatusNotFound, "not_found"
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if response.Code != status || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Error.Code != code {
			t.Fatalf("error response: %d %s", response.Code, response.Body.String())
		}
		if strings.Contains(logs.String(), "private") || strings.Contains(response.Body.String(), "private") || strings.Count(logs.String(), `"type":"operation_error"`) != 1 || strings.Count(logs.String(), `"type":"http_request"`) != 1 {
			t.Fatalf("unsafe or duplicate UI error log: %s %s", response.Body, &logs)
		}
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	httpx.RequestLogging(logger, uiHandler(logger, New(resources.New()).Page)).ServeHTTP(response, request)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled UI request wrote a response or lost cause: %s %s", response.Body, &logs)
	}
	logs.Reset()
	writer := &countFailedUIWriter{header: make(http.Header)}
	uiHandler(logger, New(resources.New()).Page)(writer, httptest.NewRequest(http.MethodGet, "/", nil))
	if writer.writes != 1 || writer.status != http.StatusOK || strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), `"phase":"response"`) || strings.Count(logs.String(), `"type":"operation_error"`) != 1 {
		t.Fatalf("failed UI writer attempted a second response or lost safe error: %+v %s", writer, &logs)
	}
}

type countFailedUIWriter struct {
	header http.Header
	writes int
	status int
}

func (w *countFailedUIWriter) Header() http.Header    { return w.header }
func (w *countFailedUIWriter) WriteHeader(status int) { w.status = status }
func (w *countFailedUIWriter) Write([]byte) (int, error) {
	w.writes++
	return 0, errors.New("private-connection-error")
}

func TestRegisterRoutesUsesProvidedResources(t *testing.T) {
	files := fstest.MapFS{"dist/index.html": &fstest.MapFile{Data: []byte("custom shell")}}
	mux := http.NewServeMux()
	New(resources.NewFromFS(files)).RegisterRoutes(mux, slog.New(slog.NewTextHandler(io.Discard, nil)))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/setup", nil))
	if response.Code != http.StatusOK || response.Body.String() != "custom shell" {
		t.Fatalf("registered route did not use provided resources: %d %q", response.Code, response.Body.String())
	}
}
