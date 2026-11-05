package webui

import (
	"io"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"

	resources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
)

var hashedAsset = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$`)

type ResourceReader interface {
	Read(name string) ([]byte, error)
}

type UI struct {
	resources ResourceReader
}

type ResponseError struct {
	Cause error
}

func (e *ResponseError) Error() string { return "web response failed" }
func (e *ResponseError) Unwrap() error { return e.Cause }

func New(resources ResourceReader) *UI { return &UI{resources: resources} }

func (u *UI) Page(w http.ResponseWriter, request *http.Request) error {
	return u.serve(w, request, "dist/index.html", "text/html; charset=utf-8", "no-store")
}

func (u *UI) Asset(w http.ResponseWriter, request *http.Request) error {
	if !strings.HasPrefix(request.URL.Path, "/assets/") {
		return resources.ErrNotFound
	}
	name := strings.TrimPrefix(request.URL.Path, "/assets/")
	if !fs.ValidPath(name) || name == "." {
		return resources.ErrNotFound
	}
	cache := "no-store"
	if hashedAsset.MatchString(path.Base(name)) {
		cache = "public, max-age=31536000, immutable"
	}
	return u.serve(w, request, "dist/assets/"+name, mime.TypeByExtension(path.Ext(name)), cache)
}

func (u *UI) serve(w http.ResponseWriter, request *http.Request, name, contentType, cache string) error {
	if err := request.Context().Err(); err != nil {
		return err
	}
	data, err := u.resources.Read(name)
	if err != nil {
		return err
	}
	if err := request.Context().Err(); err != nil {
		return err
	}
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", cache)
	w.WriteHeader(http.StatusOK)
	if request.Method == http.MethodHead {
		return nil
	}
	written, err := w.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return &ResponseError{Cause: err}
	}
	return nil
}
