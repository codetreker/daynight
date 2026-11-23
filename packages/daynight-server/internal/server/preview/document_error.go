package preview

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"html/template"
	"io"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"golang.org/x/text/language"
)

//go:embed document_error.html
var documentErrorTemplate string

var documentErrorPage = template.Must(template.New("preview-document-error").Parse(documentErrorTemplate))

const retryScript = `document.getElementById('retry').addEventListener('click',function(e){e.preventDefault();location.reload()});`

type documentErrorContent struct {
	Language, Title, Message, RetryLabel, LoginLabel, Login, RequestLabel, RequestID string
	NeedsLogin                                                                       bool
	RetryScript                                                                      template.JS
}

// documentWriter changes only an error response before headers are committed;
// successful attachment bytes remain streamed directly to the client.
type documentWriter struct {
	http.ResponseWriter
	routes   *Routes
	request  *http.Request
	replaced bool
	started  bool
}

func (w *documentWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *documentWriter) WriteHeader(status int) {
	if w.started {
		return
	}
	w.started = true
	if status < 400 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.replaced = true
	w.routes.documentError(w.ResponseWriter, w.request, status)
}

func (w *documentWriter) Write(data []byte) (int, error) {
	if !w.started {
		w.WriteHeader(http.StatusOK)
	}
	if w.replaced {
		return len(data), nil
	}
	return w.ResponseWriter.Write(data)
}

func (h *Routes) documentError(w http.ResponseWriter, r *http.Request, status int) {
	content := documentErrorContent{Language: "en", Title: "Preview unavailable", Message: "The preview is temporarily unavailable. Please try again.", RetryLabel: "Retry preview", LoginLabel: "Sign in in a new tab", Login: h.preview.String() + StartPath, RequestLabel: "Request ID", RequestID: httpx.RequestID(r.Context()), NeedsLogin: status == http.StatusUnauthorized, RetryScript: template.JS(retryScript)}
	matcher := language.NewMatcher([]language.Tag{language.English, language.SimplifiedChinese})
	_, selected := language.MatchStrings(matcher, r.Header.Values("Accept-Language")...)
	if selected == 1 {
		content.Language, content.Title, content.Message = "zh-CN", "预览暂不可用", "暂时无法打开文件预览，请重试。"
		content.RetryLabel, content.LoginLabel, content.RequestLabel = "重试预览", "在新标签页登录", "请求 ID"
	}
	var body bytes.Buffer
	if err := documentErrorPage.Execute(&body, content); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Del("Content-Disposition")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(body.Len()))
	hash := sha256.Sum256([]byte(retryScript))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors "+h.frameAncestors())
	w.WriteHeader(status)
	n, err := w.Write(body.Bytes())
	if err == nil && n != body.Len() {
		err = io.ErrShortWrite
	}
	if err != nil {
		httpx.LogFailure(h.logger, r.Context(), "preview", "document_error", err)
	}
}
