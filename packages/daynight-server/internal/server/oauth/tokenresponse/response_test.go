package tokenresponse

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type tokenWriter struct {
	*httptest.ResponseRecorder
	write func([]byte) (int, error)
}

func (w tokenWriter) Write(data []byte) (int, error) { return w.write(data) }

type failedTokenJSON struct{}

func (failedTokenJSON) MarshalJSON() ([]byte, error) {
	return nil, errors.New("private-token-must-not-log")
}

func TestWriteConfirmedTokenResponse(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/oauth/token", nil)
	w := httptest.NewRecorder()
	Write(w, r, nil, map[string]string{"access_token": "private-token"})
	if w.Code != http.StatusOK || w.Body.String() != "{\"access_token\":\"private-token\"}\n" || w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Pragma") != "no-cache" {
		t.Fatalf("status=%d header=%v body=%s", w.Code, w.Header(), w.Body.String())
	}
}

func TestWriteTokenResponseUnknownNeverRepeatsOrLeaksSecrets(t *testing.T) {
	for _, tc := range []struct {
		name       string
		value      any
		cancel     bool
		short      bool
		writeError bool
		wantStatus int
		wantWrites int
		wantBody   string
	}{
		{name: "encoding failure", value: failedTokenJSON{}, wantStatus: 503, wantWrites: 1, wantBody: "{\"error\":\"outcome_unknown\"}\n"},
		{name: "canceled after commit", value: map[string]string{"access_token": "private-token-must-not-log"}, cancel: true, wantStatus: 200},
		{name: "short write", value: map[string]string{"access_token": "private-token-must-not-log"}, short: true, wantStatus: 200, wantWrites: 1},
		{name: "failed write", value: map[string]string{"access_token": "private-token-must-not-log"}, writeError: true, wantStatus: 200, wantWrites: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancel {
				cancel()
			}
			r := httptest.NewRequest(http.MethodPost, "/oauth/token", nil).WithContext(requestid.With(ctx, "token-delivery"))
			base := httptest.NewRecorder()
			writes := 0
			w := tokenWriter{ResponseRecorder: base, write: func(data []byte) (int, error) {
				writes++
				if tc.short {
					return 1, nil
				}
				if tc.writeError {
					return 0, errors.New("private-token-must-not-log")
				}
				return base.Write(data)
			}}
			Write(w, r, logger, tc.value)
			if base.Code != tc.wantStatus || writes != tc.wantWrites || base.Body.String() != tc.wantBody || strings.Count(logs.String(), `"oauth_error_code":"outcome_unknown"`) != 1 || !strings.Contains(logs.String(), `"request_id":"token-delivery"`) || strings.Contains(logs.String(), "private-token-must-not-log") {
				t.Fatalf("status=%d writes=%d body=%s logs=%s", base.Code, writes, base.Body.String(), logs.String())
			}
		})
	}
}
