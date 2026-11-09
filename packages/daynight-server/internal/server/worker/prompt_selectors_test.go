package worker

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestPromptSelectorProtocol(t *testing.T) {
	project := "11111111-1111-4111-8111-111111111111"
	valid := `[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"worker"},"knownRevision":"0"},{"key":{"scope":"project","projectId":"` + project + `"},"knownRevision":"9223372036854775807"}]`
	cases := []struct {
		name                string
		versions, selectors []string
		ok                  bool
		count               int
	}{
		{"legacy", nil, nil, true, 0},
		{"v1", []string{"1"}, nil, true, 0},
		{"v2 empty", []string{"2"}, []string{"[]"}, true, 0},
		{"v2 three", []string{"2"}, []string{valid}, true, 3},
		{"v2 1024 bytes", []string{"2"}, []string{"[]" + strings.Repeat(" ", 1022)}, true, 0},
		{"missing version", nil, []string{"[]"}, false, 0},
		{"v1 with selector", []string{"1"}, []string{"[]"}, false, 0},
		{"missing selector", []string{"2"}, nil, false, 0},
		{"empty selector", []string{"2"}, []string{""}, false, 0},
		{"duplicate header", []string{"2"}, []string{"[]", "[]"}, false, 0},
		{"duplicate protocol", []string{"2", "2"}, []string{"[]"}, false, 0},
		{"unsupported", []string{"3"}, []string{"[]"}, false, 0},
		{"too large", []string{"2"}, []string{"[]" + strings.Repeat(" ", 1023)}, false, 0},
		{"non ASCII", []string{"2"}, []string{"[]中"}, false, 0},
		{"newline", []string{"2"}, []string{"[]\n"}, false, 0},
		{"null", []string{"2"}, []string{"null"}, false, 0},
		{"trailing", []string{"2"}, []string{"[] []"}, false, 0},
		{"missing key", []string{"2"}, []string{`[{"knownRevision":null}]`}, false, 0},
		{"missing revision", []string{"2"}, []string{`[{"key":{"scope":"user"}}]`}, false, 0},
		{"duplicate field", []string{"2"}, []string{`[{"key":{"scope":"user","scope":"user"},"knownRevision":null}]`}, false, 0},
		{"unknown field", []string{"2"}, []string{`[{"key":{"scope":"user","projectId":"` + project + `"},"knownRevision":null}]`}, false, 0},
		{"duplicate key", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"user"},"knownRevision":"0"}]`}, false, 0},
		{"four", []string{"2"}, []string{`[{},{},{},{}]`}, false, 0},
		{"bad UUID", []string{"2"}, []string{`[{"key":{"scope":"project","projectId":"bad"},"knownRevision":null}]`}, false, 0},
		{"uppercase UUID", []string{"2"}, []string{`[{"key":{"scope":"project","projectId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"},"knownRevision":null}]`}, false, 0},
		{"leading zero", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":"01"}]`}, false, 0},
		{"overflow", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":"9223372036854775808"}]`}, false, 0},
		{"numeric revision", []string{"2"}, []string{`[{"key":{"scope":"user"},"knownRevision":0}]`}, false, 0},
		{"lone surrogate", []string{"2"}, []string{`[{"key":{"scope":"\ud800"},"knownRevision":null}]`}, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			header := make(http.Header)
			if tc.versions != nil {
				header[workerConfigurationHeader] = tc.versions
			}
			if tc.selectors != nil {
				header[workerPromptsHeader] = tc.selectors
			}
			_, selectors, err := promptProtocol(header)
			if (err == nil) != tc.ok || err == nil && len(selectors) != tc.count {
				t.Fatalf("selectors=%+v error=%v", selectors, err)
			}
		})
	}
}

func TestInvalidPromptHeadersRejectBeforeReport(t *testing.T) {
	h := &workersHandler{logger: slog.Default()}
	for _, header := range []string{"", `[{"key":{"scope":"user"},"knownRevision":"01"}]`, `[] []`} {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/me/workers/11111111-1111-4111-8111-111111111111/report", strings.NewReader("{}"))
		r.SetPathValue("workerId", "11111111-1111-4111-8111-111111111111")
		r.Header.Set(workerConfigurationHeader, "2")
		r.Header.Set(workerPromptsHeader, header)
		w := httptest.NewRecorder()
		h.report(w, r, model.Principal{UserID: "22222222-2222-4222-8222-222222222222"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("header %q: %d %s", header, w.Code, w.Body)
		}
	}
}
