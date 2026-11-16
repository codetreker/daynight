package preview

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"errors"
	"html/template"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"golang.org/x/text/language"
)

//go:embed error.html
var errorTemplate string

var errorPage = template.Must(template.New("preview-sso-error").Parse(errorTemplate))

const preserveRetryFragment = `if(location.hash){document.getElementById('retry-sso').hash=location.hash}`

type errorContent struct {
	Language, Title, Message, LoginLabel, RetryLabel, HomeLabel, ProjectsLabel, RequestLabel string
	Home, Login, Retry, RequestID                                                            string
	NeedsLogin                                                                               bool
	RetryScript                                                                              template.JS
}

func (h *Routes) fail(w http.ResponseWriter, r *http.Request, phase string, err error, retry string) {
	status, code := http.StatusInternalServerError, "internal_error"
	var tooLong *httpx.URITooLongError
	if errors.As(err, &tooLong) {
		status, code = http.StatusRequestURITooLong, "uri_too_long"
	}
	if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
		switch fault.Code {
		case "unauthenticated":
			status, code = http.StatusUnauthorized, fault.Code
		case "invalid_input":
			status, code = http.StatusBadRequest, fault.Code
		case "forbidden", "permission_denied":
			status, code = http.StatusForbidden, fault.Code
		}
	}
	h.failure(w, r, phase, status, code, retry)
}

func (h *Routes) failure(w http.ResponseWriter, r *http.Request, phase string, status int, code, retry string) {
	httpx.CloseUnreadBody(w, r)
	h.logger.WarnContext(r.Context(), "preview SSO navigation failed", "component", "preview-sso", "phase", phase, "result", "failed", "error_code", code, "request_id", httpx.RequestID(r.Context()))
	if r.Context().Err() != nil {
		return
	}
	content := errorContent{
		Language: "en", Title: "Preview sign-in incomplete", Message: "The original preview could not be recovered. Return to projects or start sign-in again, which returns to projects.",
		LoginLabel: "Sign in in a new tab", RetryLabel: "Start sign-in (returns to projects)", HomeLabel: "You can return to", ProjectsLabel: "projects", RequestLabel: "Request ID",
		Home: h.main.String() + "/projects", Login: h.main.String() + "/login", Retry: h.preview.String() + StartPath, RequestID: httpx.RequestID(r.Context()),
		NeedsLogin: (phase == "authorize" || phase == "retry") && status == http.StatusUnauthorized,
	}
	if strings.HasPrefix(retry, RetryPath+"?") || ((phase == "authorize" || phase == "authorize_operation") && strings.HasPrefix(retry, AuthorizePath+"?")) {
		content.Retry = h.main.String() + retry
		content.Message = "Preview sign-in could not be completed. Retry to recover the original preview."
		content.RetryLabel = "Retry preview sign-in"
		content.RetryScript = template.JS(preserveRetryFragment)
	}
	if phase == "start" && strings.HasPrefix(retry, StartPath+"?") {
		content.Retry = h.preview.String() + retry
		content.Message = "Preview sign-in could not be completed. Retry to recover the original preview."
		content.RetryLabel = "Retry preview sign-in"
		content.RetryScript = template.JS(preserveRetryFragment)
	}
	matcher := language.NewMatcher([]language.Tag{language.English, language.SimplifiedChinese})
	_, selected := language.MatchStrings(matcher, r.Header.Values("Accept-Language")...)
	if selected == 1 {
		content.Language, content.Title, content.Message = "zh-CN", "预览登录未完成", "无法恢复原预览。请返回项目页，或重新登录并返回项目页。"
		content.LoginLabel, content.RetryLabel = "在新标签页登录", "重新登录（返回项目页）"
		content.HomeLabel, content.ProjectsLabel, content.RequestLabel = "也可以返回", "项目页", "请求 ID"
		if content.RetryScript != "" {
			content.Message = "暂时无法完成预览登录，请重试以恢复原预览。"
			content.RetryLabel = "重试预览登录"
		}
	}
	if content.NeedsLogin {
		content.Title, content.Message, content.RetryLabel = "Open attachment preview", "Sign in first, then return to this page and retry.", "Retry"
		if content.Language == "zh-CN" {
			content.Title, content.Message, content.RetryLabel = "打开附件预览", "请先登录，然后返回此页面重试。", "重试"
		}
	}
	var body bytes.Buffer
	if err := errorPage.Execute(&body, content); err != nil {
		h.logger.ErrorContext(r.Context(), "preview SSO error page failed", "component", "preview-sso", "phase", "response", "result", "encoding_failed", "request_id", httpx.RequestID(r.Context()))
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(body.Len()))
	hash := sha256.Sum256([]byte(preserveRetryFragment))
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors "+h.frameAncestors()+"; form-action 'none'")
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	n, err := w.Write(body.Bytes())
	if err == nil && n != body.Len() {
		err = io.ErrShortWrite
	}
	if err != nil {
		h.logger.ErrorContext(r.Context(), "preview SSO error response failed", "component", "preview-sso", "phase", "response", "result", "write_failed", "request_id", httpx.RequestID(r.Context()))
	}
}
