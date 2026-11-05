package server

import (
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func attachmentPathGuard(mux *http.ServeMux, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		segments := strings.Split(request.URL.EscapedPath(), "/")
		decoded := make([]string, len(segments))
		for index, segment := range segments {
			decoded[index], _ = url.PathUnescape(segment)
		}
		start := attachmentPathStart(decoded)
		_, pattern := mux.Handler(request)
		owned := start >= 0 || attachmentPathIntent(decoded) ||
			strings.HasSuffix(pattern, "/attachments/files/{path...}") || strings.HasSuffix(pattern, "/preview/{path...}") ||
			strings.HasSuffix(pattern, "/attachments/{path...}")
		if owned {
			if err := validateAttachmentURL(decoded, start); err != nil {
				w.Header().Set("Cache-Control", "no-store")
				writeError(w, request, logger, "attachment", "path", err)
				return
			}
		}
		mux.ServeHTTP(w, request)
	})
}

func validateAttachmentURL(segments []string, start int) error {
	if start < 0 {
		return invalidInput("attachment URL must not require path normalization")
	}
	for _, segment := range segments[1:] {
		if strings.Contains(segment, "/") {
			return invalidInput("attachment URL must use individually encoded path segments")
		}
	}
	if err := filestorage.ValidateAddress("task-attachments", strings.Join(segments[1:], "/")); err != nil {
		return invalidInput("attachment URL must not require path normalization")
	}
	if err := filestorage.ValidateAddress("task-attachments", strings.Join(segments[start:], "/")); err != nil {
		return invalidInput("attachment path must be a valid relative path")
	}
	return nil
}

// Intent detection must retain a namespace encountered before later parent
// segments remove it. This normalized view is never used to accept or route a URL.
func attachmentPathIntent(segments []string) bool {
	prefix := []string{""}
	for _, segment := range segments {
		for part := range strings.SplitSeq(strings.ReplaceAll(segment, "\\", "/"), "/") {
			switch part {
			case "", ".":
				continue
			case "..":
				if len(prefix) > 1 {
					prefix = prefix[:len(prefix)-1]
				}
			default:
				prefix = append(prefix, part)
			}
			if attachmentPathStart(prefix) >= 0 {
				return true
			}
		}
	}
	return false
}

func attachmentPathStart(segments []string) int {
	if len(segments) >= 6 && segments[0] == "" && segments[1] == "projects" &&
		segments[3] == "tasks" && segments[5] == "attachments" {
		return 6
	}
	if len(segments) < 8 || segments[0] != "" || segments[1] != "api" || segments[2] != "v1" ||
		segments[3] != "projects" || segments[5] != "tasks" {
		return -1
	}
	if segments[7] == "preview" {
		return 8
	}
	if len(segments) >= 9 && segments[7] == "attachments" && segments[8] == "files" {
		return 9
	}
	return -1
}
